import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

import { program, Option } from 'commander';

program
	.option('--debug')
	.addOption(new Option('--serve [port]', 'run development server on [port]').preset(8000).implies({debug: true}))
	.addOption(new Option('--host <host>', 'host to serve on').default('0.0.0.0'))
	.addOption(
		// Attempts to solve the problem of a root "portal" page
		// You should never leave the git repository and assume
		// `//umalator-global` is, say `/home/user/uma-things/uma-tools/umalator-global`
		// For all we know, a contributor might not have `/home/user/uma-things`,
		// or they might use worktree: `/home/user/uma-tools.git/master/umalator-global`
		new Option("--subpackage_of <subpackage>", "This package is subpackage of")
			.default("uma-tools")
	);


program.parse();
const options = program.opts();
const port = options.serve;
const serve = port != null;
const debug = !!options.debug;
const host = options.host;
const subpackage_of = options.subpackage_of;
const THIS_PACKAGE = "umalator-global";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// NB: the logic is so that /umalator-global/index.html is served
// a basic case would be to look for `.git` file instead of hardcoding `import.meta.url
const root = (() => {
	const url = import.meta.url;
	let dirname = path.dirname(fileURLToPath(url));
	while (!fs.existsSync(path.join(dirname, '.git'))) {
		dirname = path.dirname(dirname);
	}
	return dirname;
}) ();

const redirectData = {
	name: 'redirectData',
	setup(build) {
		build.onResolve({filter: /^\.\.?(?:\/uma-skill-tools)?\/data\//}, args => ({
			path: path.join(dirname, args.path.split('/data/')[1])
		}));
		for(const f of ['skill_meta.json', 'skill_aliases.json', 'umas.json', 'skill_trigrams.json']) {
			build.onResolve({filter: new RegExp(`${f}`)}, args => ({
				path: path.join(dirname, f)
			}));
		}
	}
};

const mockAssertFn = debug ? 'console.assert' : 'function(){}';
const mockAssert = {
	name: 'mockAssert',
	setup(build) {
		build.onResolve({filter: /^node:assert$/}, args => ({
			path: args.path, namespace: 'mockAssert-ns'
		}));
		build.onLoad({filter: /.*/, namespace: 'mockAssert-ns'}, () => ({
			contents: 'module.exports={strict:'+mockAssertFn+'};',
			loader: 'js'
		}));
	}
};

const redirectTable = {
	name: 'redirectTable',
	setup(build) {
		build.onResolve({filter: /^@tanstack\//}, args => ({
			path: path.join(dirname, '..', 'vendor', args.path.slice(10), 'index.ts')
		}));
	}
};

const buildOptions = /**@type {esbuild.BuildOptions}*/({
	entryPoints: [
		{in: '../umalator/app.tsx', out: 'bundle'}, 
		'../umalator/simulator.worker.ts',
	],
	bundle: true,
	minify: !debug,
	sourcemap: debug ? 'linked' : 'external',
	outdir: '.',
	write: !serve,
	define: {CC_DEBUG: debug.toString(), CC_GLOBAL: 'true'},
	external: ['*.ttf'],
	plugins: [redirectData, mockAssert, redirectTable],
	absWorkingDir: path.join(root, THIS_PACKAGE),  // Set the absolute working directory for resolution
});

const MIME_TYPES = {
	'.html': 'text/html; charset=UTF-8',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.map': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.otf': 'font/otf',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff'
};

const ARTIFACTS = [
	'bundle.js', 'bundle.css', 'simulator.worker.js',
];

const SOURCEMAP_ARTIFACTS = [
	'bundle.js.map', 'bundle.css.map', 'simulator.worker.js.map',
];

function runServer(
	/**@type {esbuild.BuildContext<esbuild.BuildOptions>}*/ctx, 
	/**@type {number}*/port,
	/**@type {string}*/host,
	/**@type {string|undefined}*/subpackage_of=undefined,
) {
	const requestCount = new Map([...ARTIFACTS, ...SOURCEMAP_ARTIFACTS].map(f => [f, 0]));
	let buildCount = 0;
	let output = null;
	// client makes two requests for simulator.worker.js, avoid rebuilding on the second one
	let workerState = 0;
	http.createServer(async (req, res) => {
		let url = req.url;
		// assert that url starts with /subpackage_of/THIS_PACKAGE/
		if (subpackage_of && !url.startsWith(`/${subpackage_of}/`)) {
			// actually, we should redirect to the correct url
			console.log(`GET ${req.url} 302 Redirect`);
			res.writeHead(302, {Location: `/${subpackage_of}/${THIS_PACKAGE}/`}).end();
			return;
		}
		url = url.slice(subpackage_of ? subpackage_of.length + 1 : 0);
		const filename = path.basename(url);
		if (ARTIFACTS.indexOf(filename) > -1 || SOURCEMAP_ARTIFACTS.indexOf(filename) > -1) {
			const requestN = requestCount.get(filename) + (filename == 'simulator.worker.js' ? (workerState = +!workerState) : 1);
			requestCount.set(filename, requestN);
			if (requestN != buildCount) {
				buildCount += 1;
				console.log(`rebuilding ... => ${buildCount}`);
				// NOTE: i feel like we should call ctx.cancel() here in case the previous build is running,
				// but doing so causes the rebuild to not pick up new changes for some reason? slightly confused,
				// perhaps using the API wrong
				//await ctx.cancel();
				output = new Promise(async resolve => {
					const result = await ctx.rebuild();
					resolve(new Map(result.outputFiles.map(o => [path.basename(o.path), o.contents])));
				});
			}
			console.log(`GET ${req.url} 200 OK => ${requestN}`);
			const artifact = (await output).get(filename);
			res.writeHead(200, {
				'Content-type': MIME_TYPES[path.extname(filename)],
				'Content-length': artifact.length
			}).end(artifact);
		} else {
			const fp = path.join(root, url);
			console.log({fp});
			const {exists, isDirectory, filename, fpOrIndexHtml} = await fs.promises.stat(fp).then(s => ({
				exists: true, isDirectory: s.isDirectory(), filename: s.isDirectory() ? null : path.basename(fp), fpOrIndexHtml: s.isDirectory() ? path.join(fp, 'index.html') : fp
			})).catch(() => ({
				exists: false, isDirectory: false, filename: null, fpOrIndexHtml: null
			})).then(async (e) => {
				const fpOrIndexHtml = e.fpOrIndexHtml || fp;
				const exists = await fs.promises.access(fpOrIndexHtml).then(() => true, () => false);
				return {
					...e,
					fpOrIndexHtml: exists ? fpOrIndexHtml : null,
				};
			});
			if (fpOrIndexHtml) {
				console.log(`> GET ${req.url} 200 OK`);
				res.writeHead(200, {'Content-type': MIME_TYPES[path.extname(fpOrIndexHtml)] || 'application/octet-stream'});
				console.log(`< GET ${req.url} 200 OK`);
				fs.createReadStream(fpOrIndexHtml).pipe(res);
				console.log(`< ${fpOrIndexHtml}`);
			} else {
				console.log(`GET ${req.url} 404 Not Found`, {fp, fpOrIndexHtml, exists})
				res.writeHead(404).end();
			}
		}
	}).listen(port, host);
}

if (serve) {
	const ctx = await esbuild.context(buildOptions);
	runServer(ctx, port, host, subpackage_of);

	console.log({root, dirname, subpackage_of})
	console.log(`Serving on http://${host}:${port}/${subpackage_of}/${THIS_PACKAGE}/`);
} else {
	await esbuild.build(buildOptions);
}
