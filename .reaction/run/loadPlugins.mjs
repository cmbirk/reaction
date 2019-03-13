import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';
import _ from 'lodash';
import Log from './logger';
import { exists, getDirectories } from './fs';
import pluginConfig from "../pluginConfig";

// add a message to the top of the plugins import file
const importFileMessage = `
/**
 * ***** DO NOT EDIT THIS FILE MANUALLY *****
 * This file is generated automatically by the Reaction
 * plugin loader and will be reset at each startup.
 */
`;

/**
 * Create a plugin imports file on client or server
 * @param  {String} file - absolute path to file to write
 * @param  {Array} imports - array of import path strings
 * @return {Boolean} returns true if no error
 */
function generateImportsFile(file, imports) {
  // create/reset imports file
  try {
    fs.writeFileSync(file, '');
    fs.writeFileSync(file, importFileMessage);
  } catch (e) {
    Log.error(`Failed to reset plugins file at ${file}`);
    process.exit(1);
  }

  // populate plugins file with imports
  imports.forEach((importPath) => {
    try {
      fs.appendFileSync(file, `import '${importPath}';\n`);
    } catch (e) {
      Log.error(`Failed to write to plugins file at ${importPath}`);
      process.exit(1);
    }
  });
}


/**
 * Import Reaction plugins
 * @param {String} baseDirPath - path to a plugins sub-directory (core/included/custom)
 * @return {Object} - returns object with client, server, and registry path arrays
 */
function getImportPaths(baseDirPath) {

  // get app root path
  const appRoot = path.resolve('.').split('.meteor')[0];

  // create the import path
  const getImportPath = (pluginFile) => {
    const importPath = '/' + path.relative(appRoot, pluginFile);
    return importPath.replace(/\\/g, '/');
  };

  // get all plugin directories at provided base path
  // (ignore directories starting with a dot '.' or any directories in disabledPlugins)
  const { disabledPlugins } = pluginConfig;
  const pluginDirs = _.reject(getDirectories(baseDirPath), (d) => d.charAt(0) === '.' || _.includes(disabledPlugins, d));
  const clientImportPaths = [];
  const serverImportPaths = [];
  const registryImportPaths = [];

  // read registry.json and require server/index.js if they exist
  pluginDirs.forEach((plugin) => {
    const clientImport = baseDirPath + plugin + '/client/index.js';
    const serverImport = baseDirPath + plugin + '/server/index.js';
    const registryImport = baseDirPath + plugin + '/register.js';
    const packageDotJson = baseDirPath + plugin + '/package.json';

    // import the client files if they exist
    if (exists(clientImport)) {
      clientImportPaths.push(getImportPath(clientImport.replace('/index.js', '')));
    }

    // import the server files if they exist
    if (exists(serverImport)) {
      serverImportPaths.push(getImportPath(serverImport.replace('/index.js', '')));
    }

    // import plugin registry files
    if (exists(registryImport)) {
      registryImportPaths.push(getImportPath(registryImport));
    }

    // run npm install if package.json exists
    if (exists(packageDotJson)) {
      Log.info(`Installing dependencies for ${plugin}...\n`);

      try {
        childProcess.execSync(`cd ${baseDirPath}${plugin} && meteor npm i`, { stdio: 'inherit' });
      } catch (err) {
        Log.error(`Failed to install npm dependencies for plugin: ${plugin}`);
        process.exit(1);
      }
    }
  });

  return {
    client: clientImportPaths,
    server: serverImportPaths,
    registry: registryImportPaths
  };
}


/**
 * Define base plugin paths
 */
const pluginsPath = path.resolve('.').split('.meteor')[0] + '/imports/plugins/';
const corePlugins = pluginsPath + 'core/';
const includedPlugins = pluginsPath + 'included/';
const customPlugins = pluginsPath + 'custom/';


export default function loadPlugins() {
  // get imports from each plugin directory
  const core = getImportPaths(corePlugins);
  const included = getImportPaths(includedPlugins);
  const custom = getImportPaths(customPlugins);

  // concat all imports
  const clientImports = [].concat(core.client, included.client, custom.client);
  const serverImports = [].concat(
    core.server,
    included.server,
    custom.server,
    core.registry,
    included.registry,
    custom.registry
  );

  const appRoot = path.resolve('.').split('.meteor')[0];

  // create import files on client and server and write import statements
  generateImportsFile(`${appRoot}/client/plugins.js`, clientImports);
  generateImportsFile(`${appRoot}/server/plugins.js`, serverImports);
}
