/*
Zip format documentation:
https://users.cs.jmu.edu/buchhofp/forensics/formats/pkzip.html
https://en.wikipedia.org/wiki/ZIP_(file_format)
https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
UT extra field:
  https://issues.apache.org/jira/browse/COMPRESS-210
  https://fossies.org/linux/zip/proginfo/extrafld.txt
And critic: https://games.greggman.com/game/zip-rant/

Similar lib:
https://www.npmjs.com/package/unzip-stream
*/

import {Writable} from 'stream'
import {ChunkBuffer} from './chunk-buffer.js'
import {createInflateRaw} from 'zlib'
import {GenericReadable} from './generic-readable.js'
const log = function(){} // console.log

const
  localFileHeaderSignature            = 0x504B0304,
  centralDirectoryFileHeaderSignature = 0x504B0102,
  dataDescriptorSignature             = 0x504B0708 // this is supposed to be optional

/** Extract bits from the value, starting with the LSBs (least significant bits). Provide a template object containing the bit-size of the different values to read. E.g. a normal bit flag is just 1 bit. */
function readBitField(fromValue, template) {
  if (typeof fromValue == 'number' && !Number.isSafeInteger(fromValue)) throw Error('When value is not a BigInt JS can\'t read more than 53 bits from it.')
  fromValue = BigInt(fromValue) // so we can read bits over 32
  const fieldArray = Object.entries(template)
  let valueBitIndex = 0n
  try {
    for (let fieldIndex=0; fieldIndex < fieldArray.length; fieldIndex++) {
      let result = 0, bitSize = fieldArray[fieldIndex][1]
      if (bitSize > 32) throw Error('JS can\'t do bitwise operations on more than 32 bits, so you can\'t extract a value with this bit size: '+bitSize)
      for (let resultBitIndex = 0; resultBitIndex < bitSize; resultBitIndex++) {
        if (fromValue >> valueBitIndex++ & 1n) result |= 1 << resultBitIndex
        if (resultBitIndex == bitSize-1) fieldArray[fieldIndex][1] = result >>> 0
      }
    }
  } catch (error) {
    throw Error('readBitField template error caused this error: '+error)
  }
  return Object.fromEntries(fieldArray)
}

/**
 * A class that is a Node.js `Writable` stream allowing you to pipe it the data of a Zip archive and listen for `entry` events `(header, fileStream)` that contains the header and a `Readable` stream for reading the file related to the header.
 * 
 * It doesn't do any magic for you though, what you receive is a raw Zip record header (parsed into a JavaScript Object). Depending on the `typeflag` in the header a `fileStream` might follow or not (it doesn't if it indicates a link to an earlier entry, then `linkname` contains the name of that entry).
 * 
 * For documentation of the Zip header check this: https://en.wikipedia.org/wiki/ZIP_(file_format)#File_headers
 */
export class ZipExtractStream extends Writable {
  constructor({ioTimeout=2000} = {}) {
    super() // we don't let anyone mess with its options
    this._globalHeader = {}
    this._chunkBuffer = new ChunkBuffer(ioTimeout)
    this.once('pipe', source => {
      this._source = source
      source.once('end', () => {
        log('source end')
        if (!this.writableEnded) this.end()
      })
      source.once('close', () => {
        log('source close')
      })
    })
    this._worker() // start processing data (it's async)
  }

  _write(chunk, encoding, callback) {
    // if (this.writableEnded) return callback()
    this._chunkBuffer.push(chunk)
    // this._chunkBuffer.callback = callback
    this._chunkBuffer.callbacks.push(callback)
  }

  _writev(chunks, callback) {
    this._chunkBuffer.push(...chunks.map(v => v.chunk))
    // this._chunkBuffer.callback = callback
    this._chunkBuffer.callbacks.push(callback)
  }

  _final(callback) {
    this._chunkBuffer.cleanup()
    callback()
  }

  async _parseLocalFileHeader() {
    const ref = {buffer: undefined}
    ref.buffer = await this._chunkBuffer.consume(26, undefined, true)
    let offset = 0
    const fetchString = async (size) => {
      return (await this._chunkBuffer.consume(size, undefined, true)).toString()
    }
    function readValue(size, throwIfNot) {
      let result
      switch (size) {
        case 1: result = ref.buffer.readUInt8(offset); break
        case 2: result = ref.buffer.readUInt16LE(offset); break
        case 4: result = ref.buffer.readUInt32LE(offset); break
        case 8: result = ref.buffer.readBigUInt64LE(offset); break
      }
      offset += size
      if (throwIfNot != undefined && result != throwIfNot) throw Error('Invalid value in Zip header.')
      return result
    }
    const rawHeader = { // https://www.freebsd.org/cgi/man.cgi?query=tar&sektion=5
      //signature: readValue(4, 0x504B0304), // 0x504B0304
      version: readValue(2), // version needed to extract
      ...readBitField(readValue(2), {
        encrypted: 1, // file is encrypted
        compressionOption: 2, // has different meaning depending on the compression method
        dataDescriptor: 1, // if set crc32, compressedSize and uncompressedSize are zero, the correct values are put in a data descriptor following the compressed data
        enhancedDeflation: 1,
        compressedPatchedData: 1,
        strongEncryption: 1,
        unused: 4,
        languageEncoding: 1, // if set the filename and comment are encoded using UTF-8
        reserved: 1,
        maskedHeaderValues: 1
      }),
      /* (maybe not suoport this and just throw) or then wait until the end of stream to read the "Central directory file header"?
      If the bit at offset 3 (0x08) of the general-purpose flags field is set, then the CRC-32 and file sizes are not known when the header is written. The fields in the local header are filled with zero, and the CRC-32 and size are appended in a 12-byte structure (optionally preceded by a 4-byte signature) immediately after the compressed data:
      */
      compression: readValue(2), // 0 = none, 8 = deflate
      mtime: readValue(2), // last modification time
      mdate: readValue(2), // last modification date
      crc32: readValue(4), // of the uncompressed data
      compressedSize: readValue(4),   // or 0xFFFFFFFF for ZIP64
      uncompressedSize: readValue(4), // or 0xFFFFFFFF for ZIP64
    }
    const nameLength = readValue(2)
    const extraFieldsTotalSize = readValue(2) // total length of extra fields
    rawHeader.name = await fetchString(nameLength)
    if (extraFieldsTotalSize) {
      ref.buffer = await this._chunkBuffer.consume(extraFieldsTotalSize, undefined, true)
      offset = 0
      for (let end = offset + extraFieldsTotalSize; offset < end;) {
        const fieldSignature = readValue(2)
        const fieldSize = readValue(2) // of contained data
        switch (fieldSignature) {
          default: offset += fieldSize; break
          case 0x0001: { // ZIP64 extra field record
            rawHeader.uncompressedSize = readValue(8) // these must be present
            rawHeader.compressedSize = readValue(8)
            if (fieldSize >= 24) rawHeader.headerRecordOffset = readValue(8) // maybe the central directory header offset?
            if (fieldSize >= 28) rawHeader.diskNumber = readValue(4)
          } break
          case 0x5455: { // 32-bit UTC UNIX timestamps
            log('32-bit UTC UNIX timestamps')
            const flag = readBitField(readValue(1), {
              mTimeIsPresent: 1, // bit 0 (LSB)
              aTimeIsPresent: 1,
              cTimeIsPresent: 1,
            })
            if (flag.mTimeIsPresent) rawHeader.lastModificationUnixtime = readValue(4)
            if (flag.aTimeIsPresent) rawHeader.lastAccessUnixtime = readValue(4)
            if (flag.cTimeIsPresent) rawHeader.creationUnixtime = readValue(4)
          } break
        }
      }
    }
    return rawHeader
  }

  async _parseCentralDirectory() {

  }

  async _pipeFileStream(fileStream, compressedSize, uncompressedSize) {
    let endPromise, endPromiseResolve
    endPromise = new Promise(resolve => {
      endPromiseResolve = resolve
    })
    const inflate = createInflateRaw()
    inflate.on('data', chunk => {
      fileStream.push(chunk)//.bind(fileStream)
      // if (fileStream._sizePushed >= uncompressedSize) {
      //   log('fileStream size complete', fileStream.name)
      // }
    })
    inflate.on('end', () => {
      log('fileStream ended by inflate end: '+inflate.bytesWritten, fileStream.name)
      fileStream.push(null)
      endPromiseResolve([inflate.bytesWritten, fileStream._sizePushed])
    })

    if (compressedSize == 0) { // unknown, data is folowed by data descriptor
      // then we will just decompress until inflate detects the last command, luckily Node.js allows us to detect this when it stops increasing inflate.bytesWritten (that is the bytes processed by the inflator, it doesn't process more after it's done)
      try {
        let totalWritten = 0, done = false
        while (!done) {
          const chunk = await this._chunkBuffer.consume(0, undefined, true)
          done = await new Promise(resolve => {
            log('inflate.write', chunk.length)
            inflate.write(chunk, undefined, (error) => {
              if (error) {
                log('inflate write callback error: ', error)
                this._chunkBuffer.giveBack(chunk)
                return resolve(true)
              }
              totalWritten += chunk.length
              log(fileStream.name)
              log('inflate write callback ', totalWritten, inflate.bytesWritten, chunk.length)
              // todo: what happens if same size at end?
              if (totalWritten > inflate.bytesWritten) { // means it received more than it needed to decompress the file
                log('inflate write callback detected ##END OF FILE##, bytes to give back: '+(totalWritten-inflate.bytesWritten))
                this._chunkBuffer.giveBack(chunk, totalWritten-inflate.bytesWritten)
                return resolve(true)
              }
              resolve(false) // cb must be resolved before another chunk is given
            })
          })
        }
        log('last inflate write, bytes given: '+totalWritten, fileStream.name)
        /*
        let totalWritten = 0
        const bytesConsumed = await this._chunkBuffer.consumeUntilSignature([0x50, 0x4B, 0x07, 0x08], chunk => {
          return new Promise(resolve => {
            log('inflate.write', chunk.length)
            inflate.write(chunk, undefined, () => {
              totalWritten += chunk.length
              log(fileStream.name)
              log('inflate write callback ', totalWritten, inflate.bytesWritten, chunk.length)
              if (totalWritten > inflate.bytesWritten) { // means it received more than it needed to decompress the file
                log('inflate write callback detected ##END OF FILE##, bytes to give back: '+(totalWritten-inflate.bytesWritten))
                this._chunkBuffer.giveBack(chunk, totalWritten-inflate.bytesWritten)
              }
              resolve() // cb must be resolved before another chunk is given
            })
          })
        })
        log('last inflate write, bytes given: '+bytesConsumed, fileStream.name)
        // todo: check that inflate has ended here or consume until next
        */
      } catch (error) {
        log('timeout?', error)
      }
    }
    log('#####')
    return await endPromise
    log('## ###')
    //inflate.on('end', chunk => fileStream.push(null)) // or close?

    // let bytesToConsume = 4//compressedSize
    // while (1) {//this._chunkBuffer.size) {
    //   log('bytesToConsume', bytesToConsume)
    //   let buffer
    //   if (this._chunkBuffer.size + this.writableLength >= bytesToConsume) {
    //     buffer = await this._chunkBuffer.consume(bytesToConsume, undefined, true)
    //   } else { // if less then read all it can
    //     buffer = await this._chunkBuffer.consume(this._chunkBuffer.size + this.writableLength, undefined, true)
    //   }
    //   if (buffer == false) throw Error('Stream IO timeout!') // should not happen here though
    //   inflate.write(buffer)
    //   //bytesToConsume -= buffer.length
    //   log('done consuming')
    // }
  }

  async _worker() {
    let startOfFile = true
    while (!this.writableEnded) {
      let readHeader = true
      const signature = (await this._chunkBuffer.consume(4, undefined, true)).readUInt32BE(0)
      if (startOfFile) {
        startOfFile = false
        if (signature != localFileHeaderSignature) throw Error('Invalid Zip archive signature (self extracting archives are not supported by the way).')
      } else {
        switch (signature) {
          default: throw Error('Zip file not streaming compatible or corrupted. Got signature: '+signature.toString(16))
          case centralDirectoryFileHeaderSignature:
            log('end of zip') // todo parse it and emit it
            return this.end()
          break
          case localFileHeaderSignature: {
            
          } break
        }
      }
      if (readHeader) {
        const rawHeader = await this._parseLocalFileHeader()
        // log(rawHeader)
        if (rawHeader.dataDescriptor) {
          // todo: maybe try to decompress and detect the end
          //throw Error('Zip archive using data descriptors are not supported since they can\'t be streamed.')
        }
        const header = {}
        if (rawHeader.lastModificationUnixtime) header.lastModificationTime = new Date(1000 * rawHeader.lastModificationUnixtime)
        else {
          // decode mtime mdate
          /*
          File modification time	stored in standard MS-DOS format:
            Bits 00-04: seconds divided by 2
            Bits 05-10: minute
            Bits 11-15: hour
          File modification date	stored in standard MS-DOS format:
            Bits 00-04: day
            Bits 05-08: month
            Bits 09-15: years from 1980
          */
        }
        if (rawHeader.lastAccessUnixtime) header.lastAccessTime = new Date(1000 * rawHeader.lastAccessUnixtime)
        if (rawHeader.creationUnixtime) header.creationTime = new Date(1000 * rawHeader.creationUnixtime)
        const fileStream = new GenericReadable()
        const {name, uncompressedSize: size} = rawHeader
        this.emit('entry', {name, size}, fileStream)
        fileStream.name = name                         // null if DD       if DD might be given
        const [dataDecompressed, decompressedSize] = await this._pipeFileStream(fileStream, rawHeader.compressedSize, rawHeader.uncompressedSize)
        if (rawHeader.dataDescriptor) {
          const buffer = await this._chunkBuffer.consume(4*4, undefined, true)
          const optionalSignature = buffer.readUInt32BE(0)
          let dataDescriptor
          if (optionalSignature == dataDescriptorSignature) {
            log('(optional) data Descriptor Signature found')
            dataDescriptor = {
              crc32: buffer.readUInt32LE(4),
              compressedSize: buffer.readUInt32LE(8),
              uncompressedSize: buffer.readUInt32LE(12),
            }
          } else {
            this._chunkBuffer.giveBack(buffer, 4)
            dataDescriptor = {
              crc32: buffer.readUInt32LE(0),
              compressedSize: buffer.readUInt32LE(4),
              uncompressedSize: buffer.readUInt32LE(8),
            }
          }
          if (dataDescriptor.compressedSize != dataDecompressed) log('dataDescriptor.compressedSize != dataDecompressed')
          if (dataDescriptor.uncompressedSize != decompressedSize) log('dataDescriptor.uncompressedSize != decompressedSize')
          this.emit('dataDescriptor', dataDescriptor)
        }
      }
    }
  }
}
