
import * as fs from 'node:fs'
import * as https from 'node:https'
import * as zlib from 'node:zlib'
import {resolve, sep as pathSeperator} from 'node:path'
import {pipeline} from 'node:stream'
import {TarExtractStream} from './tar-extract-stream.js'
import {ZipExtractStream} from './zip-extract-stream.js'
const moduleDirectory = import.meta.url.slice(7, import.meta.url.lastIndexOf('/')+1)
let verbose, error

function githubApiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Node.js',
        Accept: 'application/vnd.github.v3+json'
      }
    }, response => {
      if (response.statusCode != 200) {
        return reject(Error('Wrong response code: '+response.statusCode))
      }
      let json = ''
      response.setEncoding('utf-8')
      response.on('error', reject)
      response.on('data', chunk => json += chunk)
      response.on('end', () => {
        try {resolve(JSON.parse(json))} 
        catch (error) {reject(error)}
      })
    })
    .on('error', reject)
  })
}

function checkRelease(release, assetWanted) {
  const mustBeFound = new Set(['minify_linux_amd64', 'minify_windows_amd64'])
  for (const {id, name, created_at} of release.assets) {
    const fileName = name.split('.')[0]
    mustBeFound.delete(fileName)
    if (fileName == assetWanted) {
      return {assetId: id, name, version: release.tag_name}
    }
  }
  if (mustBeFound.size == 0) {
    throw true // The asset for your platform is not found (but the release format is supported)
  } else {
    throw false // This is not a proper release (or one supported by this script)
  }
}

async function findLatestSupported(wantedAsset) {
  const perPage = 30
  for (let page=1; ; page++) {
    const url = 'https://api.github.com/repos/tdewolff/minify/releases?per_page='+perPage+'&page='+page
    const releaseArray = await githubApiGet(url)
    if (releaseArray.length) {
      for (const release of releaseArray) {
        try {
          let downloadInfo = checkRelease(release, wantedAsset)
          //verbose("Ok, I'll then use release ("+release.tag_name+").")
          return downloadInfo
        } catch (error) {
          if (error === true) {
            error("I couldn't find a release for your platform: "+wantedAsset)
          } else if (error === false) {
            // then try next page eventually
          }
        }
      }
    } else {
      error("Sadly I couldn't find any.")
    }
  }
}

function writeVersionInfo(directoryPath, version) {
  fs.writeFileSync(directoryPath+'minify_version.json', JSON.stringify({tag: version}, null, 2))
}
/** Return true if update is needed. */
function compareVersionInfo(directoryPath, againstVersion) {
  try {
    const content = fs.readFileSync(directoryPath+'minify_version.json')
    const version = JSON.parse(content).tag
    return againstVersion > version
  } catch {
    return true
  }
}

function downloadAndExtract(directoryPath, {assetId, name, version}) {
  const url = 'https://api.github.com/repos/tdewolff/minify/releases/assets/'+assetId

  return new Promise((resolve, reject) => {
    function downloadStream(response) {
      let extractStream, pipes = [response]
      if (name.endsWith('.tar.gz')) {
        extractStream = new TarExtractStream()
        pipes.push(zlib.createUnzip({}))
      } else if (name.endsWith('.zip')) {
        extractStream = new ZipExtractStream()
      } else {
        error("The release didn't end in .tar.gz or .zip, hence I'm confused and have to give up.", name)
      }
      pipes.push(extractStream)
      let entryFound, entryWanted = 'minify' + (process.platform == "win32" ? '.exe' : '')
      extractStream.on('entry', (header, fileStream) => {
        if (header.name == entryWanted) {
          entryFound = true
          fileStream.pipe(fs.createWriteStream(directoryPath+header.name))
        } else {
          fileStream.resume() // ignore it
        }
      })
      verbose('Extracting the binary...')
      pipeline(...pipes, error => {
        if (error) {
          throw error
        } else {
          if (!entryFound) {
            error(entryWanted+' was not found in the archive...')
          } else {
            verbose('Success! Native binary installed!')
            resolve()
          }
        }
      })
    }
    function getAsset(url) {
      https.get(url, {
        headers: {
          'User-Agent': 'Node.js',
          Accept: 'application/octet-stream'
        }
      }, response => {
        response.on('error', reject)
        switch (response.statusCode) {
          case 200: downloadStream(response); break
          case 302: getAsset(response.headers.location); break
          default: reject(Error('Wrong response code: '+response.statusCode))
        }
      })
      .on('error', reject)
    }
    verbose('Downloading release tagged: '+version)
    getAsset(url)
  })

}

/** Returns a chmod compatible permissions integer. */
function getCurrentAccessPermissions(filePath) {
  const statMode = BigInt(fs.statSync(filePath).mode)
  let accessPermissions = 0n
  const apModes = [ // representing single bits in the mode flag
    ['S_IRUSR',	'readable by owner.'],
    ['S_IWUSR',	'writable by owner.'],
    ['S_IXUSR',	'executable by owner.'],
    ['S_IRGRP',	'readable by group.'],
    ['S_IWGRP',	'writable by group.'],
    ['S_IXGRP',	'executable by group.'],
    ['S_IROTH',	'readable by others.'],
    ['S_IWOTH',	'writable by others.'],
    ['S_IXOTH',	'executable by others.']
  ]
  for (const apMode of apModes) {
    const permissionConstant = BigInt(fs.constants[apMode[0]])
    if (statMode & permissionConstant) {
      accessPermissions |= permissionConstant
    }
  }
  return Number(accessPermissions)
}

/** Does a fs.chmod to ensure that you have these permissions without removing any permissions. 
 * @param {string} filePath
 * @param {string} permissions The names of the `fs.constants` to use, e.g. `'S_IXUSR'`.
*/
function ensureAccessPermissions(filePath, ...permissions) {
  const currentAccessPermissions = BigInt(getCurrentAccessPermissions(filePath))
  let newAccessPermissions = currentAccessPermissions
  for (const permission of permissions) {
    const permissionConstant = BigInt(fs.constants[permission])
    newAccessPermissions |= permissionConstant
  }
  if (newAccessPermissions != currentAccessPermissions) {
    fs.chmodSync(filePath, Number(newAccessPermissions))
  }
}

/** Get the latest minify release following a format understood by this script. 
 * @param {string} [directoryPath]
 * @param {boolean} quiet If `false` then verbose output is enabled and errors write to stdout (and exits the program), if `true` then verbose output is disabled and errors throw.
 * @returns {Promise} A promise which resolves when successful.
*/
export async function getLatestRelease(directoryPath, quiet = false) {
  if (quiet) {
    verbose = () => {}
    error = error => {throw Error(error)}
  } else {
    verbose = console.log
    error = error => {console.error(error); process.exit(1)}
  }
  if (!directoryPath) directoryPath = moduleDirectory+'../..'
  directoryPath = resolve(directoryPath)+pathSeperator // absolute path
  const wantedAsset = 'minify_'+process.platform+(process.arch == 'x64' ? '_amd64' : '_'+process.arch)
  const latestRelease = await githubApiGet('https://api.github.com/repos/tdewolff/minify/releases/latest')
  const versionTag = latestRelease.tag_name
  if (compareVersionInfo(directoryPath, versionTag)) {
    verbose('Trying to download the native precompiled minify binary for your platform...')
  } else {
    verbose('The latest minify binary ('+versionTag+') is present and no further actions are needed.')
    return false
  }
  let downloadInfo
  try {
    downloadInfo = checkRelease(latestRelease, wantedAsset)
  } catch (error) {
    if (error === true) {
      error("I couldn't find a release for your platform: "+wantedAsset)
    } else if (error === false) {
      verbose("The latest release ("+versionTag+") didn't include the expected release format supported by this script. I'll now look for the latest release that did...")
      downloadInfo = await findLatestSupported(wantedAsset)
    }
  }
  await downloadAndExtract(directoryPath, downloadInfo)
  ensureAccessPermissions(directoryPath+'minify'+(process.platform == "win32" ? '.exe' : ''), 'S_IXUSR', 'S_IXGRP', 'S_IXOTH')
  writeVersionInfo(directoryPath, downloadInfo.version)
  return true
}
