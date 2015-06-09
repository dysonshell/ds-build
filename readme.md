# @ds/build

定义了用于 DS 框架的 gulp 任务，使用方法，在使用 DS 的项目根目录（如 project-xxxx/web/）下的 gulpfile.js 文件中：

```js
'use strict';
GLOBAL.APP_ROOT = __dirname;
var config = require('config');
var port = parseInt(process.env.PORT, 10) || config.port || 4000;
var gulp = require('gulp');

require('@ds/build')(gulp, {
    appRoot: APP_ROOT,
    port: port,
});
```

之后这个 gulpfile.js 可以添加当前项目特定的任务（如果有的话）。

2.0.0 起，不再做 less 的编译处理，详见 `@ds/assets` 的文档。

4.0.0 起，不再改变非 `main/` 目录下的 jx 文件，详见 `@ds/watchify` 文档。
