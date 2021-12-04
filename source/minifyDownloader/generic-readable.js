
import {Readable} from 'stream'

export class GenericReadable extends Readable {
  constructor(options) {
    super(options)
    this._setWaitPromise()
    this._sizePushed = 0
  }

  _setWaitPromise() {
    if (this._waitPromise) return
    this._waitPromise = new Promise(resolve => this._waitResolve = resolve)
  }

  _read(advisorySize) { // we're now ready to be pushed more data
    if (this._waitPromise) {
      this._waitResolve()
      this._waitPromise = undefined
    }
  }

  async push(bufferToPush) { // todo: find out if a pipe use this and make it compatible
    if (this._waitPromise) await this._waitPromise // wait until it can receive more
    if (!super.push(bufferToPush)) this._setWaitPromise() // returns false when it needs to be drained
    if (bufferToPush != null) this._sizePushed += bufferToPush.length
  }

  // discard() { // just call this.resume()
  //   this.resume()
  //   while (this.read()) {}
  // }
}
