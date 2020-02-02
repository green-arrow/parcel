// @flow
import type {
  FilePath,
  ParcelConfigFile,
  ResolvedParcelConfigFile,
  PreProcessedParcelConfig,
  PackageName,
  ExtendableParcelConfigPipeline,
} from '@parcel/types';
import type {ParcelOptions} from './types';
import {resolveConfig, resolve, validateSchema} from '@parcel/utils';
import {parse} from 'json5';
import path from 'path';
import assert from 'assert';

import ParcelConfig from './ParcelConfig';
import ParcelConfigSchema from './ParcelConfig.schema';

type ConfigMap<K, V> = {[K]: V, ...};

export default async function loadParcelConfig(
  filePath: FilePath,
  options: ParcelOptions,
) {
  // Resolve plugins from cwd when a config is passed programmatically
  let parcelConfig = options.config
    ? await create(
        {
          ...options.config,
          resolveFrom: options.inputFS.cwd(),
        },
        options,
      )
    : await resolveParcelConfig(filePath, options);
  if (!parcelConfig && options.defaultConfig) {
    parcelConfig = await create(
      {
        ...options.defaultConfig,
        resolveFrom: options.inputFS.cwd(),
      },
      options,
    );
  }

  if (!parcelConfig) {
    throw new Error('Could not find a .parcelrc');
  }

  return parcelConfig;
}

export async function resolveParcelConfig(
  filePath: FilePath,
  options: ParcelOptions,
) {
  let configPath = await resolveConfig(options.inputFS, filePath, [
    '.parcelrc',
  ]);
  if (!configPath) {
    return null;
  }

  return readAndProcess(configPath, options);
}

export function create(
  config: ResolvedParcelConfigFile,
  options: ParcelOptions,
) {
  return processConfig(config, config.filePath, options);
}

export async function readAndProcess(
  configPath: FilePath,
  options: ParcelOptions,
) {
  let config: ParcelConfigFile = parse(
    await options.inputFS.readFile(configPath),
  );
  return processConfig(config, configPath, options);
}

function relatifyPipeline(
  pipeline: ?Array<PackageName>,
  filePath: FilePath,
): any {
  if (pipeline) {
    // $FlowFixMe
    return pipeline.map(pkg => {
      if (pkg === '...') return pkg;

      return {
        packageName: pkg,
        resolveFrom: filePath,
      };
    });
  }
}

function relatifyMap<T>(
  map: ?ConfigMap<any, any>,
  filePath: FilePath,
): ConfigMap<any, any> | typeof undefined {
  if (!map) return undefined;

  let res: ConfigMap<any, T> = {};
  for (let k in map) {
    if (typeof map[k] === 'string') {
      // $FlowFixMe I'm sure this is fine...
      res[k] = {
        packageName: map[k],
        resolveFrom: filePath,
      };
    } else {
      // $FlowFixMe I'm sure this is fine...
      res[k] = relatifyPipeline<ExtendableParcelConfigPipeline>(
        map[k],
        filePath,
      );
    }
  }

  return res;
}

export function preprocessConfig(
  configFile: ResolvedParcelConfigFile,
): PreProcessedParcelConfig {
  return {
    extends: configFile.extends,
    filePath: configFile.filePath,
    resolveFrom: configFile.resolveFrom,
    resolvers: relatifyPipeline(configFile.resolvers, configFile.filePath),
    transforms: relatifyMap(configFile.transforms, configFile.filePath),
    bundler: configFile.bundler
      ? {
          packageName: configFile.bundler,
          resolveFrom: configFile.filePath,
        }
      : undefined,
    namers: relatifyPipeline(configFile.namers, configFile.filePath),
    runtimes: relatifyMap(configFile.runtimes, configFile.filePath),
    packagers: relatifyMap(configFile.packagers, configFile.filePath),
    optimizers: relatifyMap(configFile.optimizers, configFile.filePath),
    reporters: relatifyPipeline(configFile.reporters, configFile.filePath),
    validators: relatifyMap(configFile.validators, configFile.filePath),
  };
}

export async function processConfig(
  configFile: ParcelConfigFile | ResolvedParcelConfigFile,
  filePath: FilePath,
  options: ParcelOptions,
) {
  // Validate config...
  let relativePath = path.relative(options.inputFS.cwd(), filePath);
  validateConfigFile(configFile, relativePath);

  // Process config...
  let resolvedFile: PreProcessedParcelConfig = preprocessConfig({
    filePath,
    ...configFile,
  });
  let config = new ParcelConfig(resolvedFile, options.packageManager);

  let extendedFiles: Array<FilePath> = [];
  if (configFile.extends) {
    let exts = Array.isArray(configFile.extends)
      ? configFile.extends
      : [configFile.extends];
    for (let ext of exts) {
      let resolved = await resolveExtends(ext, filePath, options);
      extendedFiles.push(resolved);
      let {
        extendedFiles: moreExtendedFiles,
        config: baseConfig,
      } = await readAndProcess(resolved, options);
      extendedFiles = extendedFiles.concat(moreExtendedFiles);
      config = mergeConfigs(baseConfig, resolvedFile);
    }
  }

  return {config, extendedFiles};
}

export async function resolveExtends(
  ext: string,
  configPath: FilePath,
  options: ParcelOptions,
) {
  if (ext.startsWith('.')) {
    return path.resolve(path.dirname(configPath), ext);
  } else {
    let {resolved} = await resolve(options.inputFS, ext, {
      basedir: path.dirname(configPath),
      extensions: ['.json'],
    });
    return options.inputFS.realpath(resolved);
  }
}

export function validateConfigFile(
  config: ParcelConfigFile | ResolvedParcelConfigFile,
  relativePath: FilePath,
) {
  validateNotEmpty(config, relativePath);

  validateSchema.diagnostic(
    ParcelConfigSchema,
    config,
    relativePath,
    JSON.stringify(config, null, '\t'),
    '@parcel/core',
    '',
    'Invalid Parcel Config',
  );
}

export function validateNotEmpty(
  config: ParcelConfigFile | ResolvedParcelConfigFile,
  relativePath: FilePath,
) {
  assert.notDeepStrictEqual(config, {}, `${relativePath} can't be empty`);
}

export function mergeConfigs(
  base: ParcelConfig,
  ext: PreProcessedParcelConfig,
): ParcelConfig {
  return new ParcelConfig(
    {
      filePath: ext.filePath,
      // $FlowFixMe
      resolvers: mergePipelines(base.resolvers, ext.resolvers),
      transforms: mergeMaps(base.transforms, ext.transforms, mergePipelines),
      validators: mergeMaps(base.validators, ext.validators, mergePipelines),
      bundler: ext.bundler || base.bundler,
      // $FlowFixMe
      namers: mergePipelines(base.namers, ext.namers),
      runtimes: mergeMaps(base.runtimes, ext.runtimes),
      packagers: mergeMaps(base.packagers, ext.packagers),
      optimizers: mergeMaps(base.optimizers, ext.optimizers, mergePipelines),
      // $FlowFixMe
      reporters: mergePipelines(base.reporters, ext.reporters),
    },
    base.packageManager,
  );
}

export function mergePipelines(
  base: ?ExtendableParcelConfigPipeline,
  ext: ?ExtendableParcelConfigPipeline,
): any {
  if (!ext) {
    return base || [];
  }

  if (base) {
    // Merge the base pipeline if a rest element is defined
    let spreadIndex = ext.indexOf('...');
    if (spreadIndex >= 0) {
      if (ext.filter(v => v === '...').length > 1) {
        throw new Error(
          'Only one spread element can be included in a config pipeline',
        );
      }

      ext = [
        ...ext.slice(0, spreadIndex),
        ...(base || []),
        ...ext.slice(spreadIndex + 1),
      ];
    }
  }

  return ext;
}

export function mergeMaps<K, V>(
  base: ?ConfigMap<K, V>,
  ext: ?ConfigMap<K, V>,
  merger?: (a: V, b: V) => V,
): ConfigMap<K, V> {
  if (!ext) {
    return base || {};
  }

  if (!base) {
    return ext;
  }

  // Add the extension options first so they have higher precedence in the output glob map
  let res: ConfigMap<K, V> = {};
  for (let k in ext) {
    // Flow doesn't correctly infer the type. See https://github.com/facebook/flow/issues/1736.
    let key: K = (k: any);
    res[key] = merger && base[key] ? merger(base[key], ext[key]) : ext[key];
  }

  // Add base options that aren't defined in the extension
  for (let k in base) {
    let key: K = (k: any);
    if (!res[key]) {
      res[key] = base[key];
    }
  }

  return res;
}
