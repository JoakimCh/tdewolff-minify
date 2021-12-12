
import {Minify, minifyPath} from '../../source/tdewolff-minify.js'
import * as fs from 'node:fs'
import {extname} from 'node:path'
import * as child_process from 'node:child_process'
const moduleDirectory = import.meta.url.slice(7, import.meta.url.lastIndexOf('/')+1)
const log = console.log
const fileCache = new Map()
const maxConcurrency = undefined

main()

function buildCache() {
  console.time('Caching files')
  const dirents = fs.readdirSync('test_data/', {withFileTypes: true})
  for (const dirent of dirents) {
    if (dirent.isFile()) {
      fileCache.set(dirent.name, fs.readFileSync('test_data/'+dirent.name, {encoding: 'utf-8'}))
    }
  }
  console.timeEnd('Caching files')
}

function run_nodeApiTest({
  test
}) {
  const minify = new Minify({maxConcurrency}) // allows as many concurrent processes as CPU thread count
  const jobDonePromises = []
  const dirents = fs.readdirSync('test_data/', {withFileTypes: true})
  for (const dirent of dirents) {
    if (dirent.isFile()) {
      switch (test) {
        case 0: { // node reads the file and feeds it to minify, then node feeds stdout to a file
          const readStream = fs.createReadStream('test_data/'+dirent.name)
          const writeStream = fs.createWriteStream('nodeAPI_out/'+dirent.name)
          jobDonePromises.push(minify.pipe(extname(dirent.name).slice(1), readStream, writeStream))
        } break
        case 1: { // minify reads the file, Node reads stdout
          jobDonePromises.push(
            new Promise(resolve => {
              minify.file('test_data/'+dirent.name)
              .then(minified => 
                fs.writeFile('nodeAPI_out/'+dirent.name, minified, resolve)
              )
            })
          )
        } break
        case 2: { // minify does file to file
          jobDonePromises.push(minify.fileToFile('test_data/'+dirent.name, 'nodeAPI_out/'+dirent.name))
        } break
        case 3: {
          jobDonePromises.push(
            new Promise(resolve => {
              const content = fs.readFileSync('test_data/'+dirent.name, {encoding: 'utf-8'})
              fileCache.set(dirent.name, content) // cache it for next test
              minify.content(extname(dirent.name).slice(1), content)
              .then(minified => //{resolve()}
                fs.writeFile('nodeAPI_out/'+dirent.name, minified, resolve)
              )
            })
          )
        }
      }
    }
  }
  return Promise.all(jobDonePromises) // one way to know when all the jobs are done
}

async function main() {
  process.chdir(moduleDirectory) // ensure the CWD is that of this module
  try {fs.mkdirSync('nodeAPI_out')} catch{}
  try {fs.mkdirSync('minifyCLI_out')} catch{}
  log('Starting benchmarks...')
  if (!process.argv[2]) {
    await runTest('Native minify', () => {
      child_process.spawnSync(minifyPath, ['-r', '-o', 'minifyCLI_out/', 'test_data'], {encoding: 'utf-8'})
    })
    await runTest('minify.fileToFile', () => {
      return run_nodeApiTest({test: 2})
    })
    await runTest('minify.pipe', () => {
      return run_nodeApiTest({test: 0})
    })
    await runTest('minify.file', () => {
      return run_nodeApiTest({test: 1})
    })
    await runTest('minify.content', () => {
      return run_nodeApiTest({test: 3})
    })
  } else {
    log('Running only stdin/stdout test:')
  }
  if (fileCache.size == 0) buildCache()
  await runTest('minify.content without file IO', () => {
    const minify = new Minify({maxConcurrency})
    const jobDonePromises = []
    for (const [name, content] of fileCache.entries()) {
      jobDonePromises.push(
        new Promise(resolve => {
          minify.content(extname(name).slice(1), content)
          .then(minified => {resolve()})
        })
      )
    }
    return Promise.all(jobDonePromises)
  })
  log('All done.')
}

async function runTest(title, test) {
  console.time(title)
  await test()
  console.timeEnd(title)
}
