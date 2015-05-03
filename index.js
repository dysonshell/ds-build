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
var dsRewriter = require('@ds/rewriter');
var dsWatchify = require('@ds/watchify');
var del = require('del');
var vinylPaths = require('vinyl-paths');
var exec = require('child_process').exec;

module.exports = function (gulp, opts) {

    var appRoot = opts.appRoot;
    var port = parseInt(process.env.PORT, 10) || opts.port;

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

    gulp.task('clean-tmp', function (cb) {
        del('__tmp__/', {cwd: appRoot}, cb);
    });

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
            file.base = file.base.replace('/__tmp__', '/ccc');
            file.path = file.path.replace('/__tmp__', '/ccc');
            this.push(file);
            done();
        });
    }

    gulp.task('prepare-tmp', function (cb) {
        exec('rm -rf dist__tmp__/ && cp -r node_modules/@ccc __tmp__ && cp -r ccc/* __tmp__/', {
            cwd: appRoot
        }, cb)
    });

    gulp.task('reset-rev-menifest', function () {
        var stream = $.file('rev.json', '{}');
        var d = stream.pipe(dest('dist'));
        stream.end();
        return d;
    });

    gulp.task('build-assets', ['reset-rev-menifest', 'prepare-tmp'], function () {
        return src('./__tmp__/*/img/**/*.*')
            .pipe(tReplaceTmp())
            .pipe(tRev())
            .pipe(tDest('assets'));
    });

    function sCss() {
        return es.merge(
            src(['./node_modules/@ccc/*/css/**/*.css', './ccc/*/css/**/*.css']).pipe(tReplaceCcc()),
            src('./ccc/*/css/**/*.less', { read: false })
                .pipe(through.obj(function (file, enc, done) {
                    dsAssets.renderLess(file.path, {
                        appRoot: appRoot
                    }, function (css) {
                        file.contents = new Buffer(css);
                        file.path = file.path.replace(/\.less$/, '.css');
                        this.push(file);
                        done();
                    }.bind(this));
                }))
        );
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
                }))
        )
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot, 'dist', 'rev.json'), 'utf-8'))))
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
            .pipe(rewrite(JSON.parse(fs.readFileSync(path.join(appRoot, 'dist', 'rev.json'), 'utf-8'))))
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
            .pipe(vinylPaths(del));
    });

    gulp.task('dev', function () {
        dsWatchify(opts).listen();
        $.supervisor(path.join(appRoot, 'index.js'), {
            ext: ['json', 'js'],
            args: ['--run-by-gulp'],
            ignore: ['node_modules', 'assets']
        });
    });

};
