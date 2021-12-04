
import {Minify, minifyStream, minifyPath} from 'tdewolff-minify'
import {Writable} from 'node:stream'
const moduleDirectory = import.meta.url.slice(7, import.meta.url.lastIndexOf('/')+1)
const log = console.log

process.chdir(moduleDirectory)

/** Allows a `Writable` stdout stream that doesn't close the actual stdout. */
function stdoutWritable() {
  return new Writable({
    write(chunk, _encoding, callback) {
      process.stdout.write(chunk, callback)
    }
  })
}

/* Initialize the minify controller and allow max 4 running 
minify processes at once. */
const minify = new Minify({maxConcurrency: 4})

/* Since the API is asynchronous it's important to catch errors 
correctly. The minifier will throw errors if it has any trouble 
with the syntax of the file to minify. */

/* Here we try to minify a file: */
try { // (a try/catch block works well with await)
  const result = await minify.file('fileToMinify.js')
  log('success:', result, '\n')
} catch (error) {
  log('error:', error, '\n')
}

/* Here we try to minify a JavaScript we supply: */
minify.content('js', 'let a = 123;')
  .then( // (an alternative to using await)
    result => log('success:', result, '\n'),
    error => log('error:', error, '\n')
  )

/* Here we will do some plumbing: */
const {createReadStream} = await import('node:fs')
// const outStream = fs.createWriteStream('fileToMinify.min.js')
await minify.pipe('js',
  createReadStream('fileToMinify.js'),
  stdoutWritable()
)
log('\n')

/* Here we'll show how to use pipeline:
(if you want to use pipeline then you must handle 
concurrency yourself instead of using the controller)  */
const {createGzip}          = await import('node:zlib')
const {pipeline, Transform} = await import('node:stream')

pipeline(
  createReadStream('fileToMinify.js'), // get the text
  await minifyStream('js'), // minfy it
  createGzip(), // gzip it (like a web-server would do)
  new Transform({ // hex encode it
    transform(chunk, _encoding, callback) {
      callback(null, chunk.toString('hex'))
    }
  }), 
  stdoutWritable(), // and display it
  error => { // the callback when done
    if (error) log('\n', error, '\n')
    else log('\n\nSuccess', '\n')
  }
)

log('Minify path:', minifyPath, '\n')

/* Here we have minify write the minified contents to another file: */
try {
  await minify.fileToFile('fileToMinify.js', 'fileToMinify.min.js')
} catch (error) {
  log('error:', error, '\n')
}
