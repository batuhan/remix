import { promises as fsp } from "fs";
import * as path from "path";
import { builtinModules as nodeBuiltins } from "module";
import * as esbuild from "esbuild";
import debounce from "lodash.debounce";
import chokidar from "chokidar";

import { BuildMode, BuildTarget } from "./build";
import type { RemixConfig } from "./config";
import { readConfig } from "./config";
import invariant from "./invariant";
import { warnOnce } from "./warnings";
import { createAssetsManifest } from "./compiler/assets";
import { getAppDependencies } from "./compiler/dependencies";
import { loaders, getLoaderForFile } from "./compiler/loaders";
import { mdxPlugin } from "./compiler/plugins/mdx";
import { getRouteModuleExportsCached } from "./compiler/routes";
import { writeFileSafe } from "./compiler/utils/fs";

// When we build Remix, this shim file is copied directly into the output
// directory in the same place relative to this file. It is eventually injected
// as a source file when building the app.
const reactShim = path.resolve(__dirname, "compiler/shims/react.ts");

interface BuildConfig {
  mode: BuildMode;
  target: BuildTarget;
  sourcemap: boolean;
}

function defaultWarningHandler(message: string, key: string) {
  warnOnce(false, message, key);
}

function defaultBuildFailureHandler(failure: Error | esbuild.BuildFailure) {
  if ("warnings" in failure || "errors" in failure) {
    if (failure.warnings) {
      let messages = esbuild.formatMessagesSync(failure.warnings, {
        kind: "warning",
        color: true
      });
      console.warn(...messages);
    }

    if (failure.errors) {
      let messages = esbuild.formatMessagesSync(failure.errors, {
        kind: "error",
        color: true
      });
      console.error(...messages);
    }
  }

  console.error(failure?.message || "An unknown build error occurred");
}

interface BuildOptions extends Partial<BuildConfig> {
  onWarning?(message: string, key: string): void;
  onBuildFailure?(failure: Error | esbuild.BuildFailure): void;
}

export async function build(
  config: RemixConfig,
  {
    mode = BuildMode.Production,
    target = BuildTarget.Node14,
    sourcemap = false,
    onWarning = defaultWarningHandler,
    onBuildFailure = defaultBuildFailureHandler
  }: BuildOptions = {}
): Promise<void> {
  await buildEverything(config, {
    mode,
    target,
    sourcemap,
    onWarning,
    onBuildFailure
  });
}

interface WatchOptions extends BuildOptions {
  onRebuildStart?(): void;
  onRebuildFinish?(): void;
  onFileCreated?(file: string): void;
  onFileChanged?(file: string): void;
  onFileDeleted?(file: string): void;
  onInitialBuild?(): void;
}

export async function watch(
  config: RemixConfig,
  {
    mode = BuildMode.Development,
    target = BuildTarget.Node14,
    sourcemap = true,
    onWarning = defaultWarningHandler,
    onBuildFailure = defaultBuildFailureHandler,
    onRebuildStart,
    onRebuildFinish,
    onFileCreated,
    onFileChanged,
    onFileDeleted,
    onInitialBuild
  }: WatchOptions = {}
): Promise<() => Promise<void>> {
  let options = {
    mode,
    target,
    sourcemap,
    onBuildFailure,
    onWarning,
    incremental: true
  };
  let [browserBuild, serverBuild] = await buildEverything(config, options);

  let initialBuildComplete = !!browserBuild && !!serverBuild;
  if (initialBuildComplete) {
    onInitialBuild?.();
  }

  function disposeBuilders() {
    browserBuild?.rebuild?.dispose();
    serverBuild?.rebuild?.dispose();
    browserBuild = undefined;
    serverBuild = undefined;
  }

  let restartBuilders = debounce(async (newConfig?: RemixConfig) => {
    disposeBuilders();
    try {
      newConfig = await readConfig(config.rootDirectory);
    } catch (error) {
      onBuildFailure(error as Error);
      return;
    }

    config = newConfig;
    if (onRebuildStart) onRebuildStart();
    let builders = await buildEverything(config, options);
    if (onRebuildFinish) onRebuildFinish();
    browserBuild = builders[0];
    serverBuild = builders[1];
  }, 500);

  let rebuildEverything = debounce(async () => {
    if (onRebuildStart) onRebuildStart();

    if (!browserBuild?.rebuild || !serverBuild?.rebuild) {
      disposeBuilders();

      try {
        [browserBuild, serverBuild] = await buildEverything(config, options);

        if (!initialBuildComplete) {
          initialBuildComplete = !!browserBuild && !!serverBuild;
          if (initialBuildComplete) {
            onInitialBuild?.();
          }
        }
        if (onRebuildFinish) onRebuildFinish();
      } catch (err: any) {
        onBuildFailure(err);
      }
      return;
    }

    await Promise.all([
      // If we get here and can't call rebuild something went wrong and we
      // should probably blow as it's not really recoverable.
      browserBuild
        .rebuild()
        .then(build => generateManifests(config, build.metafile!)),
      serverBuild.rebuild()
    ]).catch(err => {
      disposeBuilders();
      onBuildFailure(err);
    });
    if (onRebuildFinish) onRebuildFinish();
  }, 100);

  let watcher = chokidar
    .watch(config.appDirectory, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      }
    })
    .on("error", error => console.error(error))
    .on("change", async file => {
      if (onFileChanged) onFileChanged(file);
      await rebuildEverything();
    })
    .on("add", async file => {
      if (onFileCreated) onFileCreated(file);
      let newConfig: RemixConfig;
      try {
        newConfig = await readConfig(config.rootDirectory);
      } catch (error) {
        onBuildFailure(error as Error);
        return;
      }

      if (isEntryPoint(newConfig, file)) {
        await restartBuilders(newConfig);
      } else {
        await rebuildEverything();
      }
    })
    .on("unlink", async file => {
      if (onFileDeleted) onFileDeleted(file);
      if (isEntryPoint(config, file)) {
        await restartBuilders();
      } else {
        await rebuildEverything();
      }
    });

  return async () => {
    await watcher.close().catch(() => {});
    disposeBuilders();
  };
}

function isEntryPoint(config: RemixConfig, file: string) {
  let appFile = path.relative(config.appDirectory, file);

  if (
    appFile === config.entryClientFile ||
    appFile === config.entryServerFile
  ) {
    return true;
  }
  for (let key in config.routes) {
    if (appFile === config.routes[key].file) return true;
  }

  return false;
}

///////////////////////////////////////////////////////////////////////////////

async function buildEverything(
  config: RemixConfig,
  options: Required<BuildOptions> & { incremental?: boolean }
): Promise<(esbuild.BuildResult | undefined)[]> {
  // TODO:
  // When building for node, we build both the browser and server builds in
  // parallel and emit the asset manifest as a separate file in the output
  // directory.
  // When building for Cloudflare Workers, we need to run the browser and server
  // builds serially so we can inline the asset manifest into the server build
  // in a single JavaScript file.

  try {
    let browserBuildPromise = createBrowserBuild(config, options);
    let serverBuildPromise = createServerBuild(config, options);

    return await Promise.all([
      browserBuildPromise.then(async build => {
        await generateManifests(config, build.metafile!);
        return build;
      }),
      serverBuildPromise
    ]);
  } catch (err) {
    options.onBuildFailure(err as Error);
    return [undefined, undefined];
  }
}

async function createBrowserBuild(
  config: RemixConfig,
  options: BuildOptions & { incremental?: boolean }
): Promise<esbuild.BuildResult> {
  // For the browser build, exclude node built-ins that don't have a
  // browser-safe alternative installed in node_modules. Nothing should
  // *actually* be external in the browser build (we want to bundle all deps) so
  // this is really just making sure we don't accidentally have any dependencies
  // on node built-ins in browser bundles.
  let dependencies = Object.keys(await getAppDependencies(config));
  let externals = nodeBuiltins.filter(mod => !dependencies.includes(mod));
  let fakeBuiltins = nodeBuiltins.filter(mod => dependencies.includes(mod));

  if (fakeBuiltins.length > 0) {
    throw new Error(
      `It appears you're using a module that is built in to node, but you installed it as a dependency which could cause problems. Please remove ${fakeBuiltins.join(
        ", "
      )} before continuing.`
    );
  }

  let entryPoints: esbuild.BuildOptions["entryPoints"] = {
    "entry.client": path.resolve(config.appDirectory, config.entryClientFile)
  };
  for (let id of Object.keys(config.routes)) {
    // All route entry points are virtual modules that will be loaded by the
    // browserEntryPointsPlugin. This allows us to tree-shake server-only code
    // that we don't want to run in the browser (i.e. action & loader).
    entryPoints[id] =
      path.resolve(config.appDirectory, config.routes[id].file) + "?browser";
  }

  return esbuild.build({
    entryPoints,
    outdir: config.assetsBuildDirectory,
    platform: "browser",
    format: "esm",
    external: externals,
    inject: [reactShim],
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    splitting: true,
    sourcemap: options.sourcemap,
    metafile: true,
    incremental: options.incremental,
    minify: options.mode === BuildMode.Production,
    entryNames: "[dir]/[name]-[hash]",
    chunkNames: "_shared/[name]-[hash]",
    assetNames: "_assets/[name]-[hash]",
    publicPath: config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode)
    },
    plugins: [
      mdxPlugin(config),
      browserRouteModulesPlugin(config, /\?browser$/),
      emptyModulesPlugin(config, /\.server(\.[jt]sx?)?$/)
    ]
  });
}

async function createServerBuild(
  config: RemixConfig,
  options: Required<BuildOptions> & { incremental?: boolean }
): Promise<esbuild.BuildResult> {
  let dependencies = Object.keys(await getAppDependencies(config));

  return esbuild.build({
    stdin: {
      contents: getServerEntryPointModule(config, options),
      resolveDir: config.serverBuildDirectory
    },
    outfile: path.resolve(config.serverBuildDirectory, "index.js"),
    platform: config.serverPlatform,
    format: config.serverModuleFormat,
    mainFields:
      config.serverModuleFormat === "esm"
        ? ["module", "main"]
        : ["main", "module"],
    target: options.target,
    inject: [reactShim],
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    incremental: options.incremental,
    sourcemap: options.sourcemap ? "inline" : false,
    // The server build needs to know how to generate asset URLs for imports
    // of CSS and other files.
    assetNames: "_assets/[name]-[hash]",
    publicPath: config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode)
    },
    plugins: [
      mdxPlugin(config),
      serverRouteModulesPlugin(config),
      emptyModulesPlugin(config, /\.client(\.[jt]sx?)?$/),
      manualExternalsPlugin((id, importer) => {
        // assets.json is external because this build runs in parallel with the
        // browser build and it's not there yet.
        if (id === "./assets.json" && importer === "<stdin>") return true;

        // Mark all bare imports as external. They will be require()'d (or imported if esm) at
        // runtime from node_modules.
        if (isBareModuleId(id)) {
          let packageName = getNpmPackageName(id);
          if (
            !/\bnode_modules\b/.test(importer) &&
            !nodeBuiltins.includes(packageName) &&
            !dependencies.includes(packageName)
          ) {
            options.onWarning(
              `The path "${id}" is imported in ` +
                `${path.relative(process.cwd(), importer)} but ` +
                `${packageName} is not listed in your package.json dependencies. ` +
                `Did you forget to install it?`,
              packageName
            );
          }

          // include .css files from node_modules in the build
          // so we can get a hashed file name to put into the HTML
          if (id.endsWith(".css")) return false;

          // include "remix" in the build so the server runtime (node) doesn't have to try
          // to find the magic exports
          if (packageName === "remix") return false;

          return true;
        }

        return false;
      })
    ]
  });
}

function isBareModuleId(id: string): boolean {
  return !id.startsWith(".") && !id.startsWith("~") && !path.isAbsolute(id);
}

function getNpmPackageName(id: string): string {
  let split = id.split("/");
  let packageName = split[0];
  if (packageName.startsWith("@")) packageName += `/${split[1]}`;
  return packageName;
}

async function generateManifests(
  config: RemixConfig,
  metafile: esbuild.Metafile
): Promise<string[]> {
  let assetsManifest = await createAssetsManifest(config, metafile);

  let filename = `manifest-${assetsManifest.version.toUpperCase()}.js`;
  assetsManifest.url = config.publicPath + filename;

  return Promise.all([
    writeFileSafe(
      path.join(config.assetsBuildDirectory, filename),
      `window.__remixManifest=${JSON.stringify(assetsManifest)};`
    ),
    writeFileSafe(
      path.join(config.serverBuildDirectory, "assets.json"),
      JSON.stringify(assetsManifest, null, 2)
    )
  ]);
}

function getServerEntryPointModule(
  config: RemixConfig,
  options: BuildOptions
): string {
  switch (options.target) {
    case BuildTarget.Node14:
      return `
import * as entryServer from ${JSON.stringify(
        path.resolve(config.appDirectory, config.entryServerFile)
      )};
${Object.keys(config.routes)
  .map((key, index) => {
    let route = config.routes[key];
    return `import * as route${index} from ${JSON.stringify(
      path.resolve(config.appDirectory, route.file)
    )};`;
  })
  .join("\n")}
export { default as assets } from "./assets.json";
export const entry = { module: entryServer };
export const routes = {
  ${Object.keys(config.routes)
    .map((key, index) => {
      let route = config.routes[key];
      return `${JSON.stringify(key)}: {
    id: ${JSON.stringify(route.id)},
    parentId: ${JSON.stringify(route.parentId)},
    path: ${JSON.stringify(route.path)},
    index: ${JSON.stringify(route.index)},
    caseSensitive: ${JSON.stringify(route.caseSensitive)},
    module: route${index}
  }`;
    })
    .join(",\n  ")}
};`;
    default:
      throw new Error(
        `Cannot generate server entry point module for target: ${options.target}`
      );
  }
}

type Route = RemixConfig["routes"][string];

const browserSafeRouteExports: { [name: string]: boolean } = {
  CatchBoundary: true,
  ErrorBoundary: true,
  default: true,
  handle: true,
  links: true,
  meta: true,
  unstable_shouldReload: true
};

/**
 * This plugin loads route modules for the browser build, using module shims
 * that re-export only the route module exports that are safe for the browser.
 */
function browserRouteModulesPlugin(
  config: RemixConfig,
  suffixMatcher: RegExp
): esbuild.Plugin {
  return {
    name: "browser-route-modules",
    async setup(build) {
      let routesByFile: Map<string, Route> = Object.keys(config.routes).reduce(
        (map, key) => {
          let route = config.routes[key];
          map.set(path.resolve(config.appDirectory, route.file), route);
          return map;
        },
        new Map()
      );

      build.onResolve({ filter: suffixMatcher }, args => {
        return { path: args.path, namespace: "browser-route-module" };
      });

      build.onLoad(
        { filter: suffixMatcher, namespace: "browser-route-module" },
        async args => {
          let file = args.path.replace(suffixMatcher, "");
          let route = routesByFile.get(file);
          invariant(route, `Cannot get route by path: ${args.path}`);

          let exports;
          try {
            exports = (
              await getRouteModuleExportsCached(config, route.id)
            ).filter(ex => !!browserSafeRouteExports[ex]);
          } catch (error: any) {
            return {
              errors: [
                {
                  text: error.message,
                  pluginName: "browser-route-module"
                }
              ]
            };
          }
          let spec = exports.length > 0 ? `{ ${exports.join(", ")} }` : "*";
          let contents = `export ${spec} from ${JSON.stringify(file)};`;

          return {
            contents,
            resolveDir: path.dirname(file),
            loader: "js"
          };
        }
      );
    }
  };
}

/**
 * This plugin substitutes an empty module for any modules in the `app`
 * directory that match the given `filter`.
 */
function emptyModulesPlugin(
  config: RemixConfig,
  filter: RegExp
): esbuild.Plugin {
  return {
    name: "empty-modules",
    setup(build) {
      build.onResolve({ filter }, args => {
        let resolved = path.resolve(args.resolveDir, args.path);
        if (
          // Limit this behavior to modules found in only the `app` directory.
          // This allows node_modules to use the `.server.js` and `.client.js`
          // naming conventions with different semantics.
          resolved.startsWith(config.appDirectory)
        ) {
          return { path: args.path, namespace: "empty-module" };
        }
      });

      build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => {
        return {
          // Use an empty CommonJS module here instead of ESM to avoid "No
          // matching export" errors in esbuild for stuff that is imported
          // from this file.
          contents: "module.exports = {};",
          loader: "js"
        };
      });
    }
  };
}

/**
 * This plugin loads route modules for the server build.
 */
function serverRouteModulesPlugin(config: RemixConfig): esbuild.Plugin {
  return {
    name: "server-route-modules",
    setup(build) {
      let routeFiles = new Set(
        Object.keys(config.routes).map(key =>
          path.resolve(config.appDirectory, config.routes[key].file)
        )
      );

      build.onResolve({ filter: /.*/ }, args => {
        if (routeFiles.has(args.path)) {
          return { path: args.path, namespace: "route-module" };
        }
      });

      build.onLoad({ filter: /.*/, namespace: "route-module" }, async args => {
        let file = args.path;
        let contents = await fsp.readFile(file, "utf-8");

        // Default to `export {}` if the file is empty so esbuild interprets
        // this file as ESM instead of CommonJS with `default: {}`. This helps
        // in development when creating new files.
        // See https://github.com/evanw/esbuild/issues/1043
        if (!/\S/.test(contents)) {
          return { contents: "export {}", loader: "js" };
        }

        return {
          contents,
          resolveDir: path.dirname(file),
          loader: getLoaderForFile(file)
        };
      });
    }
  };
}

/**
 * This plugin marks paths external using a callback function.
 */
function manualExternalsPlugin(
  isExternal: (id: string, importer: string) => boolean
): esbuild.Plugin {
  return {
    name: "manual-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (isExternal(args.path, args.importer)) {
          return { path: args.path, external: true };
        }
      });
    }
  };
}
