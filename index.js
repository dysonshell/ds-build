'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var config = require('config');
assert(config.dsAppRoot);
var Readable = require('stream').Readable;
var $ = require('gulp-load-plugins')();
require('ds-nrequire');
require('ds-brequire');
var bpack = require('browser-pack');
var xtend = require('xtend');
var through = require('through2');
var es = require('event-stream');
var streamCombine = require('stream-combiner');
var dsRewriter = require('ds-rewriter');
var dsGlob = require('ds-glob');
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
var _ = require('lodash');
var VFile = require('vinyl');
var Promise = require('bluebird');
var dsWatchify = require('ds-watchify');
var co = require('co');

// config
var APP_ROOT = config.dsAppRoot;
var DSC = config.dsComponentPrefix || 'dsc';
var DSCns = DSC.replace(/^\/+/, '').replace(/\/+$/, '');
DSC = DSCns + '/';
var port = parseInt(process.env.PORT, 10) || config.port || 4000;
process.env.APP_ROOT = APP_ROOT;
process.env.PORT = ''+port;

module.exports = function (gulp, opts) {

    var port = Number(process.env.PORT || opts.port);

    function rewrite(revMap) {
        return through.obj(function (obj, enc, cb) {
            obj.contents = new Buffer(dsRewriter(revMap, obj.contents.toString('utf-8')));
            this.push(obj);
            cb();
        });
    }

    function src(glob, opts) {
        var xopts = {
            cwd: APP_ROOT
        };
        opts = opts ? xtend(xopts, opts) : xopts;
        return gulp.src.call(gulp, glob, opts);
    }

    function dest() {
        var destPath = path.join.apply(path, [APP_ROOT].concat([].slice.call(
            arguments)));
        return gulp.dest(destPath);
    }

    function tRev(prefix) {
        return streamCombine(
            through.obj(function (obj, enc, cb) {
                obj.base = prefix ? path.join(APP_ROOT, prefix) : APP_ROOT;
                this.push(obj);
                cb();
            }),
            $.rev()
        );
    }

    function tDest() {
        var fullRevPath = path.join(APP_ROOT, 'dist', 'rev.json');
        return streamCombine(
            dest('dist'), // write revisioned assets to /dist
            through.obj(function (obj, enc, cb) {
                console.log(obj.path);
                this.push(obj);
                cb();
            }),
            $.rev.manifest(fullRevPath, {
                path: fullRevPath,
                base: path.join(APP_ROOT, 'dist'),
                cwd: APP_ROOT,
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

    function tReplaceDsc() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/node_modules/@'+DSC, '/'+DSC);
            file.path = file.path.replace('/node_modules/@'+DSC, '/'+DSC);
            this.push(file);
            done();
        });
    }

    function tReplaceTmp() {
        return through.obj(function (file, enc, done) {
            file.base = file.base.replace('/'+DSC+'.tmp/', '/'+DSC);
            file.path = file.path.replace('/'+DSC+'.tmp/', '/'+DSC);
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
        return src(['./node_modules/@'+DSC+'*/img/**/*', './'+DSC+'*/img/**/*'])
            .pipe(tReplaceDsc())
            .pipe(tRev())
            .pipe(tDest());
    });

    function sCss() {
        return src(['./'+DSC+'.tmp/*/css/**/*.css']).pipe(tReplaceTmp());
    }

    gulp.task('build-css', ['build-assets'], function () {
        require('./precss');
        return sCss()
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev())
            .pipe(tDest('css'));
    });

    var globalLibsPath = path.join(APP_ROOT, DSC, 'libs.json');
    if (!fs.existsSync(globalLibsPath)) {
        fs.writeFileSync(globalLibsPath, '[]', 'utf-8');
    }
    var globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'));
    var globalExternals = globalLibs.map(function (x) {
        return x[1] || x[0];
    }).filter(Boolean);

    var globalPreloadPath = path.join(APP_ROOT, DSC, 'preload.js');
    if (!fs.existsSync(globalPreloadPath)) {
        fs.writeFileSync(globalPreloadPath, '', 'utf-8');
    }

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
    var globalSrc;
    gulp.task('build-global-js', function () {
        return co(function *() {
            globalSrc =
            (yield dsWatchify.bundle(globalPreloadPath, {
                watch: false,
                preludeSync: true,
            })).toString() + '\n;' +
            (yield dsWatchify.bundle(false, {
                global: true,
                watch: false,
                alterb: function (b) {
                    globalLibs.forEach(function (x) {
                        b.require(x[0], {expose: x[1] || x[0]});
                    });
                },
            })).toString();
            console.log(globalSrc.length);
        });
    });
    gulp.task('build-js', ['build-global-js', 'build-css'], function () {
        var bcp = fs.readFileSync(require.resolve('browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        var files = dsGlob.sync(DSC+'*/js/main/**/*.js').map(require.resolve);
        //var globalJsSrc = fs.readFileSync(require.resolve('@ds/common/dist/'+DSC+'global.js'), 'utf8');
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
                        b.external(globalExternals)
                        b.pipeline.get('deps').splice(1, 0, removeExternalDeps());
                        b.on('reset', function () {
                            this.external(globalExternals)
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
                                    only: new RegExp(DSCns + '\\\/'),
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
                    basedir: APP_ROOT,
                    commonJsPath: DSC+'common.js' //"node_modules" will be removed
                }))
                .pipe(tReplaceDsc())
                .pipe(through.obj(function (file, enc, done) {
                    if (file.path === path.join(APP_ROOT, DSC+'common.js')) {
                        console.log('----- -----');
                        console.log(Object.keys(file));
                        console.log(file.cwd);
                        console.log(file.base);
                        console.log(file.path);
                        console.log(file.stat);
                        console.log('----- -----');
                        /*
                            var contents = file.contents.toString('utf8');
                            file.contents = new Buffer(globalJsSrc + contents);
                            */
                        this.push(new VFile({
                            cwd: file.cwd,
                            base: file.base,
                            path: file.path.replace(/common\.js$/, 'global.js'),
                            contents: new Buffer(globalSrc, 'utf-8'),
                        }));
                        this.push(new VFile({
                            cwd: file.cwd,
                            base: file.base,
                            path: file.path.replace(/common\.js$/, 'global-common.js'),
                            contents: new Buffer(globalSrc.replace(/\[\]\)([\r\n\s]+\/\/#\s+sourceMapping)/, '[false])$1') + ';' + file.contents.toString(), 'utf-8'),
                        }));
                    }
                    this.push(file);
                    done();
                })),
            src([
                './node_modules/@'+DSC+'*/js/**/*.js',
                './'+DSC+'*/js/**/*.js',
                '!**/js/main/**',
                '!**/js/lib/**',
            ])
                .pipe(tReplaceDsc())
        )
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'dist', 'rev.json'), 'utf-8'))))
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
        var watchifyServerPath = require.resolve('ds-watchify/server.js');
        var rpath = path.relative(APP_ROOT, watchifyServerPath);
        $.supervisor(watchifyServerPath, {
            ext: ['js'],
            watch: [rpath],
        });

        $.supervisor(path.join(APP_ROOT, 'index.js'), {
            ext: ['json', 'js'],
            watch: ['config', 'index.js'],
        });
    });
};
