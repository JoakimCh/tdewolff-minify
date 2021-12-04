
const verbose = function(){} // console.log

/** Create a promise that resolves after `timeout` milliseconds with the specified `returnValue`. This is intended to be used with Promise.race().
 * @param {number} [timeout=2000] When to resolve the promise, defaults to 2 seconds.
 * @param {*} [returnValue='timeout'] What to resolve it with, defaults to 'timeout'.
 * @returns {[Promise, Function]} [promise, clearTimeout] clearTimeout can optionally be used to resolve the promise and clear the timeout if you do not need to wait for it anymore (to allow the garbage collector to free the resources immediately).
 * @example
 * const [timeoutPromise, clearTimeout] = createTimeoutPromise(2000, false)
 * if (false == await Promise.race([
 *   anotherPromise, // returns something different than false
 *   timeoutPromise // race it with timeout (returns false)
 * ])) {
 *   verbose('timed out')
 * } else clearTimeout() // so garbage collector can collect it
 */
function createTimeoutPromise(timeout = 2000, returnValue = 'timeout') {
  let resolver, timer
  return [new Promise(resolve => {
    resolver = resolve
    timer = setTimeout(resolve, timeout, returnValue).unref()
  }), () => {
    clearTimeout(timer)
    resolver()
  }]
}

async function racePromisesWithTimeout(timeoutTime, timeoutReturnValue, ...promises) {
  if (typeof timeoutTime != 'number') throw Error('timeoutTime must be a number...')
  if (promises.length == 0) throw Error('You need at least one promise to race against the timeout...')
  const uniqueObjectReference = {}
  const [timeoutPromise, clearTimeout] = createTimeoutPromise(timeoutTime, uniqueObjectReference)
  const raceWinnerReturnValue = await Promise.race([timeoutPromise, ...promises])
  if (raceWinnerReturnValue == uniqueObjectReference) {
    return timeoutReturnValue
  } else clearTimeout() // so garbage collector can collect it
  return raceWinnerReturnValue
}

/** A class for buffering chunks of data and making them easier to work with. */
export class ChunkBuffer {
  constructor(ioTimeout=2000) {
    this._ioTimeout = ioTimeout
    this._chunks = []
    this._size = 0
    this.callbacks = [] // the callback to call when we're ready for more data
    this._setWaitPromise()
  }

  /** Get the size of data stored in the buffer. */
  get size() {return this._size}

  _setWaitPromise() {
    this._waitPromise = new Promise(resolve => this._waitResolve = resolve)
  }

  /** Push new chunks of data into the buffer.
   * @param {Buffer} chunks
   */
  push(...chunks) {
    verbose('push:', chunks)
    this._chunks.push(...chunks)
    for (const chunk of chunks) {
      this._size += chunk.length
    }
    if (this._waitPromise) {
      this._waitResolve(true)
      this._waitPromise = undefined
    }
  }

  giveBack(chunk, bytesAtEndToGiveBack = 0) {
    const leftovers = chunk.subarray(bytesAtEndToGiveBack ? chunk.length - bytesAtEndToGiveBack : 0)
    this._chunks = [leftovers]
    this._size = leftovers.length
    verbose('giving back leftover bytes: ', leftovers.length)
    if (this._waitPromise) {
      this._waitResolve(true)
      this._waitPromise = undefined
    }
  }

  /** Consume data from the buffer (waits for it to be available if not).
   * @param {number} [sizeWanted] The amount of bytes to consume, `undefined` or `0` to consume any amount.
   * @param {number} [ioTimeout] If no new chunks of data are received within this time then abort and return `false` (the total time used to get all the wanted data can exceed this timeout). If set to `undefined` then it will use the value set in the constructor.
   * @param {boolean} [throwOnTimeout] Whether to throw on timeout or not.
   * @returns {Buffer|false} Node.js `Buffer` or `false` if IO-timeout.
   */
  async consume(sizeWanted, ioTimeout=this._ioTimeout, throwOnTimeout) {
    verbose('consume:', sizeWanted)
    if (typeof sizeWanted != 'number') sizeWanted = 0
    let bufferToConsume
    if (sizeWanted && sizeWanted != this._size) { // if larger or smaller
      if (this._size > sizeWanted) { // if larger than wanted
        const buffer = Buffer.concat(this._chunks, this._size) // merge all into one
        // verbose(this._chunks.length, this._size, sizeWanted)
        bufferToConsume = buffer.subarray(0, sizeWanted) // consume the size requested
        const leftovers = buffer.subarray(sizeWanted) // and put back the leftovers
        // verbose(leftovers)
        this._chunks = [leftovers]
        this._size = leftovers.length
      }
    } else if (this._size) { // if same size or no size specified (and there is data to consume)
      bufferToConsume = Buffer.concat(this._chunks, this._size)
      this._chunks = []
      this._size = 0
    }
    if (bufferToConsume) { // if enough data to consume
      return bufferToConsume
    } else { // wait for data to be ready
      do {
        if (false == await this._waitForMore(ioTimeout, throwOnTimeout)) {
          return false // if it didn't throw it will return false on timeout
        }
      } while (this._size < sizeWanted)
      return await this.consume(sizeWanted) // try again (this will not recurse since we already waited for the data to be ready)
    }
  }

  resolveCallbacks() {
    let callback
    while (callback = this.callbacks.shift()) {
      verbose('call for more')
      setImmediate(callback) // this solved a hang btw
    }
  }

  async _waitForMore(ioTimeout, throwOnTimeout) {
    if (!this._waitPromise) this._setWaitPromise()
    this.resolveCallbacks()
    if (this._waitPromise) {
      verbose('wait for more data', this._size)
      if (false == await racePromisesWithTimeout(ioTimeout, false, this._waitPromise)) {
        if (throwOnTimeout) throw Error('IO timeout!')
        verbose('io timed out')
        return false // indicating io timeout
      }
      verbose('done waiting')
    }
  }

  async consumeUntilSignature(signatureBytes, onChunk, ioTimeout=this._ioTimeout, throwOnTimeout) {
    const finder = new FindBytes(signatureBytes)
    let consumedBytes = 0
    if (this._chunks.length == 0) await this._waitForMore(ioTimeout, throwOnTimeout)
    outer: while (this._chunks.length) {
      const chunk = this._chunks.shift()
      this._size -= chunk.length
      for (let chunkOffset=0; chunkOffset < chunk.length; chunkOffset++) {
        if (finder.look(chunk.readUint8(chunkOffset))) {
          chunkOffset++
          const leftovers = chunk.subarray(chunkOffset) // put back leftovers
          this._chunks = [leftovers]; this._size = leftovers.length
          consumedBytes += chunkOffset
          await onChunk(chunk.subarray(0, chunkOffset))  // we do not need to wait for the last one?
          break outer
        }
      }
      consumedBytes += chunk.length
      await onChunk(chunk) // must wait until done before calling again, maybe allow return value to end the consumption, it could return how much it needed and then we will put back the leftovers
      verbose('onChunk done')
      // if this times out then while exits, hence it's important that this._size is correct
      if (this._chunks.length == 0) await this._waitForMore(ioTimeout, throwOnTimeout)
    }
    return consumedBytes
  }

  /** We're done, so clean up. Allows the garbage collector free any chunks not consumed. */
  cleanup() {
    this._chunks = []
    this._size = 0
    this.resolveCallbacks()
  }
}

class FindBytes {
  constructor(bytes) {
    this._bytesToFind = bytes
    this._index = 0
  }
  // look for sequence, returns true when found
  look(byte) {
    if (byte == this._bytesToFind[this._index++]) {
      if (this._index == this._bytesToFind.length) {
        this._index = 0
        return true
      }
    } else {
      this._index = 0
    }
    return false
  }
}
