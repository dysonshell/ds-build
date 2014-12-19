'use strict';
var $ = require('gulp-load-plugins')();
var path = require('path');
var xtend = require('xtend');
var mime = require('mime');
var through = require('through2');
var assets = require('@ds/assets');
var rewrite = require('rev-rewriter');

module.exports = function (gulp, app, rootPath) {
    function src(glob, opts) {
        var xopts = {
            cwd: rootPath
        };
        opts = opts ? xtend(xopts, opts) : xopts;
        return gulp.src.call(gulp, glob, opts);
    }

    var assetsCache = {};
    var assetsRevMap = {};
    var port = process.env.PORT;

    function processAssets(stream) {
        return stream
            .pipe(through.obj(function (file, enc, cb) {
                file.base = rootPath;
                if (file.contents) {
                    this.push(file);
                }
                cb();
            }))
            .pipe(through.obj(function (file, enc, cb) {
                /*
                console.log(file);
                console.log(file.base);
                console.log(file.path);
                console.log(file.contents);*/
                this.push(file);
                var relativePath = path.relative(rootPath, file.path);
                var index = relativePath.indexOf('/assets');
                var relativeDir = relativePath.substring(0, index);
                var reqPath = relativePath.substring(index);
                var extname = path.extname(reqPath);
                var revvedPath = reqPath
                    .substring(0, reqPath.length - extname.length) +
                    '@' + relativeDir + extname;
                assetsCache[revvedPath] = {
                    path: reqPath,
                    revvedPath: revvedPath,
                    mime: mime.lookup(extname),
                    contents: file.contents
                };
                assetsRevMap[reqPath] = revvedPath;
                console.log(assetsCache);
                console.log(assetsRevMap);
                cb();
            }));
    }

    gulp.task('assets', function () {
        return processAssets(src([
            './components/**/assets/**',
            '!./components/**/assets/**/*.less'
        ]));
    });

    gulp.task('watch:assets', ['assets'], function () {
        return processAssets($.watch([
            './components/**/assets/**',
            '!./components/**/assets/**/*.less'
        ]));
    });

    var cssRootPath = path.join(rootPath, 'assets', 'css');
    var lessFiles = [];

    function buildComponentsLess() {
        var content = lessFiles
            .map(function (relativePath) {
                return '@import "' + relativePath +
                    '";';
            })
            .join('\n');
        var filePath = path.join(rootPath, 'assets', 'css',
            'components.less');
        assets.renderLess(filePath, content, function (css) {
            console.log(css);
            var revvedCss = rewrite({
                revMap: assetsRevMap
            }, css);
            console.log(revvedCss);
            assetsCache['/assets/css/components.css'] = {
                path: '/assets/css/components.css',
                revvedPath: '/assets/css/components.css',
                mime: 'text/css; charset=utf-8',
                contents: revvedCss
            };
            console.log(assetsCache);
            console.log(assetsRevMap);
        });
        assetsRevMap['/assets/css/components.css'] =
            '/assets/css/components.css';
    }
    //            .pipe($.watch('./components/**/assets/css/style.less'))

    gulp.task('less', function () {
        return src('./components/**/assets/css/style.less')
            .pipe(through.obj(function (file, enc, cb) {
                var relativePath = path.relative(cssRootPath, file.path);
                if (lessFiles.indexOf(relativePath) === -1) {
                    lessFiles.push(relativePath);
                    this.push(file);
                }
                cb();
            }))
            .on('end', buildComponentsLess);
    });
    gulp.task('watch:less', function () {
        return $.watch('./components/**/assets/css/style.less')
            .pipe(through.obj(function (file, enc, cb) {
                this.push(file);
                buildComponentsLess();
                cb();
            }));
    });

    gulp.task('dev', ['assets', 'less'], function () {
        assets
            .argmentApp(app, {
                assetsCache: assetsCache
            });
        var server = require('http')
            .createServer(app);
        server.listen(function () {
            console.log(
                '----------\ndev server listening http://localhost:' +
                server.address()
                .port + '\n----------');
        });
        gulp.run('watch:assets', 'watch:less');
    });

    gulp.task('default', ['dev']);
};