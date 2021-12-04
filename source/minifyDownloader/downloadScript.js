/*
This script is ran during package installation to download a prebuilt binary of minify for your platform.
*/
import {getLatestRelease} from './minifyDownloader.js'
const moduleDirectory = import.meta.url.slice(7, import.meta.url.lastIndexOf('/')+1)
await getLatestRelease(moduleDirectory+'../..')
