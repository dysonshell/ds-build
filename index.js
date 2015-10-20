'use strict';
var fs = require('fs');
var path = require('path');
var $ = require('gulp-load-plugins')();
var bpack = require('browser-pack');
var dsAssets = require('@ds/assets');
var xtend = require('xtend');
var through = require('through2');
var es = require('event-stream');
var streamCombine = require('stream-combiner');
var dsRewriter = require('@ds/rewriter');
var cccglob = require('@ds/cccglob');
var dsWatchify = require('@ds/watchify');
var del = require('del');
var vinylPaths = require('vinyl-paths');
var exec = require('child_process').exec;
var mqRemove = require('mq-remove');
var browserify = require('browserify');
var partialify = require('partialify');
var babelify = require('babelify');
var es3ify = require('es3ify-safe');
var grtrequire = require('grtrequire');
var semver = require('semver');
var dsWatchifyVersion = require('@ds/watchify/package.json').version;
var dsNrequireVersion = require('@ds/nrequire/package.json').version;

module.exports = function (gulp, opts) {

    var appRoot = opts.appRoot;
    GLOBAL.APP_ROOT = appRoot;
    require('@ds/nrequire');
    require('@ds/brequire');
    var port = Number(process.env.PORT || opts.port);
    process.env.APP_ROOT = appRoot;
    process.env.PORT = port;
    require('@ds/common');

    function rewrite(revMap) {
        return through.obj(function (obj, enc, cb) {
            obj.contents = new Buffer(dsRewriter(revMap, obj.contents.toString('utf-8')));
            this.push(obj);
            cb();
        });
    }

    function src(glob, opts) {
        var xopts = {
            cwd: appRoot
        };
        opts = opts ? xtend(xopts, opts) : xopts;
        return gulp.src.call(gulp, glob, opts);
    }

    function dest() {
        var destPath = path.join.apply(path, [appRoot].concat([].slice.call(
            arguments)));
        return gulp.dest(destPath);
    }

    function tRev(prefix) {
        return streamCombine(
            through.obj(function (obj, enc, cb) {
                obj.base = prefix ? path.join(appRoot, prefix) : appRoot;
                this.push(obj);
                cb();
            }),
            $.rev()
        );
    }

    function tDest() {
        var fullRevPath = path.join(appRoot, 'dist', 'rev.json');
        return streamCombine(
            dest('dist'), // write revisioned assets to /dist
            through.obj(function (obj, enc, cb) {
                console.log(obj.path);
                this.push(obj);
                cb();
            }),
            $.rev.manifest(fullRevPath, {
                path: fullRevPath,
                base: path.join(appRoot, 'dist'),
                cwd: appRoot,
                merge: true
            }), // generate a revision manifest file
            through.obj(function (obj, enc, cb) {
                console.log(obj.path);
                this.push(obj);
                cb();
            }),
            dest('dist') // write it to /dist/rev-manifest.json
        );
    }

    function tReplaceCcc() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/node_modules/@ccc', '/ccc');
            file.path = file.path.replace('/node_modules/@ccc', '/ccc');
            this.push(file);
            done();
        });
    }

    function tReplaceTmp() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/ccc/tmp/', '/ccc/');
            file.path = file.path.replace('/ccc/tmp/', '/ccc/');
            this.push(file);
            done();
        });
    }

    gulp.task('reset-rev-menifest', function () {
        var stream = $.file('rev.json', '{}');
        var d = stream.pipe(dest('dist'));
        stream.end();
        return d;
    });

    gulp.task('build-assets', ['reset-rev-menifest'], function () {
        return src(['./node_modules/@ccc/*/img/**/*', './ccc/*/img/**/*'])
            .pipe(tReplaceCcc())
            .pipe(tRev())
            .pipe(tDest());
    });

    function sCss() {
        return src(['./ccc/tmp/*/css/**/*.css']).pipe(tReplaceTmp());
    }

    gulp.task('build-css', ['build-assets'], function () {
        require('./precss');
        return sCss()
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev())
            .pipe(tDest('css'));
    });

    var commonGlobalJs = _.uniq([]
        .concat(require('@ds/common/external.json'))
        .concat(opts.commonjs)
        .filter(Boolean));
    function removeExternalDeps() {
        return through.obj(function (row, enc, done) {
            row.deps = _.transform(row.deps, function (result, dep, key) {
                if (dep) { // only add back if it's not false (which indicates the dep is external)
                    result[key] = dep;
                }
            });
            this.push(row);
            done();
        })
    }
    gulp.task('build-js', ['build-css'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = cccglob.sync('ccc/*/js/main/**/*.js').map(require.resolve);
        var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/ccc/global.js'), 'utf8');
        return es.merge(
            src(files)
                .pipe(through.obj(function (file, enc, done) {
                    console.log('trying to browserify js file: ' + file.path);
                    this.push(file);
                    done();
                }))
                .pipe($.factorBundle({
                    b: (function() {
                        var b = new browserify({
                            detectGlobals: false,
                        });
                        b.external(commonGlobalJs)
                        b.pipeline.get('deps').splice(1, 0, removeExternalDeps());
                        b.on('reset', function () {
                            this.external(commonGlobalJs)
                            this.pipeline.get('deps').splice(1, 0, removeExternalDeps());
                            this.pipeline.get('dedupe').splice(0, 1);
                        });
                        return b;
                    }()),
                    alterPipeline: function alterPipeline(pipeline, b) {
                        if (!b.transformPatched) {
                            b
                                .transform(grtrequire, {global: true})
                                .transform(partialify, {global: true})
                                .transform(babelify.configure({
                                    optional: ["es7.functionBind"],
                                    only: /ccc\//,
                                }), {global: true})
                                .transform(es3ify, {global: true});
                            b.transformPatched = true;
                        }
                        pipeline.get('pack')
                            .splice(0, 1, bpack(xtend(b._options, {
                                raw: true,
                                hasExports: false,
                                prelude: bcp
                            })));
                    },
                    basedir: appRoot,
                    commonJsPath: 'ccc/global.js' //"node_modules" will be removed
                }))
                .pipe(tReplaceCcc())
                .pipe(through.obj(function (file, enc, done) {
                    if (file.path === path.join(appRoot, 'ccc/global.js')) {
                        var contents = file.contents.toString('utf8');
                        file.contents = new Buffer(globalJsSrc + contents);
                    }
                    this.push(file);
                    done();
                })),
            src([
                './node_modules/@ccc/*/js/**/*.js',
                './ccc/*/js/**/*.js',
                '!**/js/main/**',
                '!**/js/lib/**',
            ])
                .pipe(tReplaceCcc())
        )
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev())
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to uglify js file: ' + file.path);
                this.push(file);
                done();
            }))
            .pipe($.uglify({
                compress: {
                    //drop_console: true
                },
                output: {
                    ascii_only: true,
                    quote_keys: true
                }
            }))
            .pipe(tDest('js', 'node_modules'));
    });

    gulp.task('build', ['build-js']);

    gulp.task('build-and-clean', ['build'], function () {
        return src('./dist/**/*')
            .pipe($.revOutdated(5))
            .pipe(vinylPaths(del));
    });

    gulp.task('dev', function () {
        var watchifyServerPath;
        try {
            watchifyServerPath = require.resolve('@ds/watchify/server.js');
        } catch (e) {}
        if (watchifyServerPath) {
            var rpath = path.relative(appRoot, require.resolve('@ds/watchify/server.js'));
            $.supervisor(watchifyServerPath, {
                cwd: path.dirname(watchifyServerPath),
                ext: ['js'],
                watch: [rpath],
            });
        } else {
            dsWatchify(opts).listen();
        }
        var supervisorOptions = {
            ext: ['json', 'js'],
            args: ['--run-by-gulp'],
        }
        if (semver.gte(dsNrequireVersion, '1.3.0')) {
            supervisorOptions.watch = ['config', 'index.js'];
            // 其他所有文件都会在改动后 process.exit(0); 这样触发重启
        } else {
            supervisorOptions.ignore = ['node_modules', 'assets'];
        }
        $.supervisor(path.join(appRoot, 'index.js'), supervisorOptions);
    });

};
