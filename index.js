'use strict';
var fs = require('fs');
var path = require('path');
var $ = require('gulp-load-plugins')();
var bpack = require('browserify/node_modules/browser-pack');
var dsAssets = require('@ds/assets');
var xtend = require('xtend');
var through = require('through2');
var es = require('event-stream');
var streamCombine = require('stream-combiner');
var rewriter = require('@ds/rewriter');
var watchify = require('@ds/watchify');
var exec = require('child_process')
    .exec;
var spawn = require('child_process')
    .spawn;

module.exports = function (gulp, opts) {

    var appRoot = opts.appRoot;
    var port = parseInt(process.env.PORT, 10) || opts.port;

    function rewrite(revMap) {
        return through.obj(function (obj, enc, cb) {
            obj.contents = new Buffer(rewriter(revMap, obj.contents.toString(
                'utf-8')));
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

    function tDest(type, prefix) {
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

    gulp.task('reset-rev-menifest', function () {
        var stream = $.file('rev.json', '{}');
        var d = stream.pipe(dest('dist'));
        stream.end();
        return d;
    });

    gulp.task('build-assets', ['reset-rev-menifest'], function () {
        return src(['./assets/img/**/*.*', './ccc/*/img/**/*.*'])
            .pipe(tRev())
            .pipe(tDest('assets'));
    });

    function sCss() {
        return es.merge(
            src(['./assets/css/**/*.css', './ccc/*/css/**/*.css']),
            src(['./assets/css/**/*.less', './ccc/*/css/**/*.less'], {
                read: false
            })
            .pipe(through.obj(function (file, enc, done) {
                dsAssets.renderLess(file.path, {
                    componentsDirName: 'ccc',
                    appRoot: appRoot
                }, function (css) {
                    file.contents = new Buffer(css);
                    file.path = file.path.replace(/\.less$/,
                        '.css');
                    this.push(file);
                    done();
                }.bind(this));
            })));
    }

    gulp.task('build-css', ['build-assets'], function () {
        return es.merge(
            sCss(),
            sCss()
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to remove media-queries for: ' + file.path);
                this.push(file);
                done();
            }))
            .pipe($.mqRemove({
                width: '1024px'
            }))
            .pipe($.rename({
                suffix: '.nmq',
                extname: '.css'
            })))
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot,
                'dist', 'rev.json'), 'utf-8')), '/assets/'))
            .pipe(tRev())
            .pipe(tDest('css'));
    });

    gulp.task('build-js', ['build-css'], function () {
        var bcp = fs.readFileSync(require.resolve(
            'browserify-common-prelude/dist/bcp.min.js'), 'utf-8');
        return es.merge(src(['./node_modules/assets/js/main/**/*.js',
                './node_modules/ccc/*/js/main/**/*.js'
            ], {
                base: appRoot
            })
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to browserify js file: ' + file.path);
                this.push(file);
                done();
            }))
            .pipe($.factorBundle({
                alterPipeline: function alterPipeline(pipeline, b) {
                    pipeline.get('pack')
                        .splice(0, 1, bpack(xtend(b._options, {
                            raw: true,
                            hasExports: false,
                            prelude: bcp
                        })));
                },
                basedir: appRoot,
                commonJsPath: 'node_modules/assets/js/common/global.js' //"node_modules" will be removed
            })), src(['node_modules/assets/js/**/*.js', '!**/js/main/**']))
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot,
                'dist', 'rev.json'), 'utf-8'))))
            .pipe(tRev('node_modules'))
            .pipe(through.obj(function (file, enc, done) {
                console.log('trying to uglify js file: ' + file.path);
                this.push(file);
                done();
            }))
            .pipe($.uglify({
                compress: {
                    drop_console: true
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
            .pipe($.revOutdated(3))
            .pipe($.rimraf());
    });

    /* isMasterRunning
     * 判断 pm master 是否正在运行
     * 在运行，返回 pid(string)
     * 不在运行，返回 false
     */
    function isMasterRunning() {
        var pidFilePath = path.join(appRoot, 'ds.pid');
        var strpid;
        var isRunning;
        if (fs.existsSync(pidFilePath)) {
            strpid = fs.readFileSync(pidFilePath, 'utf-8');
            isRunning = require('is-running')(parseInt(strpid, 10));
        }
        if (isRunning) {
            return strpid;
        }
        return false;
    }

    function reload() {
        var strpid = isMasterRunning();
        if (strpid) {
            console.log('pm master is running. sending USR1 signal...');
            exec('kill -s USR1 ' + strpid);
        } else {
            console.log('pm master is not running. spawning one...');
            spawn(process.execPath, [path.join(appRoot, 'master.js')], {
                cwd: appRoot,
                env: xtend(process.env, {
                    NODE_ENV: 'production'
                }),
                silent: true,
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore']
            })
                .unref();
        }
    }

    gulp.task('start', ['build-and-clean'], reload);
    gulp.task('reload', reload);
    gulp
        .task('stop', function () {
            var strpid = isMasterRunning();
            if (strpid) {
                console.log('pm master is running. terminating...');
                exec('kill -s TERM ' + strpid);
            } else {
                console.log('pm master is not running. exiting...');
            }
        });

    gulp.task('dev', function () {
        watchify(opts).listen();
        $.supervisor(path.join(appRoot, 'index.js'), {
            ext: ['json', 'js'],
            args: ['--run-by-gulp'],
            ignore: ['node_modules', 'assets']
        });
    });

};
