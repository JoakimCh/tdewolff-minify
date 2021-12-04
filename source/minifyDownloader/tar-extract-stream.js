
import {Writable} from 'stream'
import {ChunkBuffer} from './chunk-buffer.js'
import {GenericReadable} from './generic-readable.js'
const verbose = function(){}//console.log

/**
 * A class that is a Node.js `Writable` stream allowing you to pipe it the data of a Tar archive and listen for `entry` events `(header, fileStream)` that contains the header and a `Readable` stream for reading the file related to the header.
 * 
 * It doesn't do any magic for you though, what you receive is a raw Tar record header (parsed into a JavaScript Object). Depending on the `typeflag` in the header a `fileStream` might follow or not (it doesn't if it indicates a link to an earlier entry, then `linkname` contains the name of that entry).
 * 
 * For documentation of the Tar header check this: https://www.freebsd.org/cgi/man.cgi?query=tar&sektion=5
 */
export class TarExtractStream extends Writable {
  constructor({ioTimeout=2000} = {}) {
    super() // we don't let anyone mess with its options
    this._endOfTar = false
    this._globalHeader = {}
    this._chunkBuffer = new ChunkBuffer(ioTimeout)
    this.once('pipe', source => {
      this._source = source
      source.once('end', () => {
        verbose('source end')
        if (!this.writableEnded) this.end()
      })
      source.once('close', () => {
        verbose('source close')
      })
    })
    this._worker() // start processing data (it's async)
  }
  
  _write(chunk, encoding, callback) {
    if (this._endOfTar) return callback()
    this._chunkBuffer.push(chunk)
    this._chunkBuffer.callbacks.push(callback)
  }

  _writev(chunks, callback) {
    if (this._endOfTar) return callback()
    this._chunkBuffer.push(...chunks.map(v => v.chunk))
    this._chunkBuffer.callbacks.push(callback)
  }

  async _pipeFileStream(fileStream, size) {
    let bytesToPush = size
    let bytesToConsume = Math.ceil(size/512) * 512 // align to 512 blocks
    while (bytesToConsume) {
      verbose('bytesToConsume', bytesToConsume)
      let buffer
      if (this._chunkBuffer.size + this.writableLength >= bytesToConsume) {
        buffer = await this._chunkBuffer.consume(bytesToConsume)
      } else { // if less then read all it can
        buffer = await this._chunkBuffer.consume(this._chunkBuffer.size + this.writableLength)
      }
      if (buffer == false) throw Error('Stream IO timeout!') // should not happen here though
      bytesToConsume -= buffer.length
      if (bytesToPush) {
        const bufferToPush = buffer.subarray(0, bytesToPush)
        verbose('push')
        await fileStream.push(bufferToPush)
        verbose('push completed')
        bytesToPush -= bufferToPush.length
        if (bytesToPush == 0) {
          fileStream.push(null) // end stream
        }
      }
    }
    verbose('done consuming')
  }

  async _worker() {
    while (!this.writableEnded) {
      let header = await this._parseHeader()
      if (header == null) { // end of tar
        this._endOfTar = true
        this._chunkBuffer.cleanup()
        return // exit worker
      } else {
        switch (header.typeflag) {
          case 'g': case 'x': { // pax entries follows as the "file"
            const paxEntries = await this._parsePaxEntries(header.size)
            if (header.typeflag == 'g') this._globalHeader = paxEntries
            header = { // then merge them
              ...header = await this._parseHeader(), // read the following header
              ...paxEntries
            }
          } break
        }
        if (header.linkname == null) { // if file data follows
          // emit fileStream and pipe data to it until next header
          const fileStream = new GenericReadable()
          // https://stackoverflow.com/questions/15349733/setimmediate-vs-nexttick
          this.emit('entry', header, fileStream)
          await this._pipeFileStream(fileStream, header.size)
        } else { // if not
          this.emit('entry', header)
        }
      }
    }
  }

  async _parseHeader() {
    const buffer = await this._chunkBuffer.consume(512)
    if (buffer == false) throw Error('Stream IO timeout!')
    verbose('header', buffer.length, buffer.toString())
    let offset = 0, allZero = true // used in entry()
    function entry(size, isOctal) {
      let strSize
      for (strSize = 0; strSize < size; strSize ++) {
        const byte = buffer.readUInt8(offset+strSize)
        if (byte >> 7 & 1) { // if MSB is set then it's a binary encoded number
          verbose('binary value in header')
          if (size*8 < 64) throw Error('Binary header fields of less than 64 bits not supported, yet...')
          const value = buffer.readBigUInt64BE(offset+size-8) // read the LSBs into a 64-bit two's complement number
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw Error('Binary header value doesn\'t fit in 53 bits.')
          offset += size; allZero = false
          return Number(value)
        }
        if (byte == 0) break
      }
      if (strSize == 0) {
        offset += size
        return null
      } else {
        allZero = false
      }
      const result = new TextDecoder('utf-8').decode(buffer.subarray(offset, offset+strSize))
      offset += size
      return isOctal ? parseInt(result, 8) : result
    }
    const header = { // https://www.freebsd.org/cgi/man.cgi?query=tar&sektion=5
      name: entry(100), // filename
      mode: entry(8, true), // also in PAX header
      uid: entry(8, true),
      gid: entry(8, true),
      size: entry(12, true),
      mtime: entry(12, true), // also in PAX header
      checksum: entry(8),
      typeflag: entry(1),   // if 1 then it's a link to previous written file
      linkname: entry(100), // then linkname is the name of that file
      magic: entry(6),
      version: entry(2),
      uname: entry(32),
      gname: entry(32),
      devmajor: entry(8, true), // major and minor numbers for character device or block device entry
      devminor: entry(8, true),
      prefix: entry(155), // prefix for filename, e.g. path
      ...this._globalHeader, // if any
    }
    if (allZero) return null // a tar file ends with two or more zeroed 512 header records (just 1 is probably enough to indicate the end though)
    // verbose(header)
    return header
  }

  async _parsePaxEntries(size) {
    const bufferSize = Math.ceil(size/512) * 512 // align to 512 blocks
    const buffer = await this._chunkBuffer.consume(bufferSize)
    if (buffer == false) throw Error('Stream IO timeout!')
    const text = new TextDecoder('utf-8').decode(buffer.subarray(0, size))
    const paxEntries = {}
    for (const line of text.split('\n')) {
      const
        a = line.indexOf(' '),
        b = line.indexOf('='),
        length = +line.substring(0, a),
        key = line.substring(a, b),
        value = line.substring(b+1)
      paxEntries[key] = value
      if (length != line.length) verbose('hmm', length, line.length)
    }
    return paxEntries
  }
}
