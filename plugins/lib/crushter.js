'use strict';

/**!
 * [square]
 * @copyright (c) 2012 observe.it (observe.it) <opensource@observe.it>
 * MIT Licensed
 */

/**
 * Native modules.
 */
var spawn = require('child_process').spawn
  , cluster = require('cluster')
  , zlib = require('zlib')
  , path = require('path')
  , os = require('os');

/**
 * Third party modules.
 */
var canihaz = require('canihaz')('square')
  , request = require('request')
  , async = require('async');

/**
 * A fork received a new task to process.
 *
 * Task:
 *
 * task.engines: Comma seperated list of compressors that need to be used
 * task.extension: The file extension of content
 * task.content: The actual content that needs to be processed
 * task.gzip: Calculate the size of content after gzipping it
 * task.id: The id of this task (private)
 *
 * @param {Object} task
 */
if (!cluster.isMaster) process.on('message', function message(task) {
  var engines = exports[task.extension]
    , started = Date.now()
    , durations = {};

  async.reduce(
      task.engines.split(/\,\s+?/)
    , task
    , function reduce(memo, engine, done) {
        var backup = memo.content;

        // Compile the shizzle.
        if (engine in engines) {
          durations[engine] = Date.now();

          return engines[engine](memo, function crush(err, content) {
            durations[engine] = Date.now() - durations[engine];

            if (err) {
              memo.content = backup;
              return done(err, memo);
            }

            // Update the content and process all the things again, and again and
            // again.
            memo.content = content;
            done(err, memo);
          });
        }

        // The engine does not exist, send an error response
        process.nextTick(function () {
          done(new Error('The engine '+ engine +' does not exist'), memo);
        });
      }
    , function done(err, result) {
        result = result || task || {};

        // Add some metrics about this task like:
        // - The total time it took to process this task
        // - The time each individual compiler took to compress the content
        result.duration = Date.now() - started;
        result.individual = durations;

        if (!result.gzip || err) return process.send(err, result);

        // We want to calculate the size of the generated code once it has been
        // gzipped as that might be more important to users than the actual file
        // size after minification.
        result.gzip = 0;
        zlib.gzip(result.content, function gzip(err, buff) {
          if (err) return process.send(err, result);

          result.gzip = buff.length;
          process.send(err, result);
        });
      }
  );
});

/**
 * Send a message to the workers that they need to start processing something.
 *
 *
 * @param {Object} task work for the workers
 * @param {Function} cb callback
 * @api public
 */
exports.send = function send(task, cb) {
  if (!exports.initialized) exports.initialize();

  var worker = exports.workers.pop();

  task.id = task.id || Date.now();  // use an id to tie a task to a callback
  worker.queue[task.id] = cb || function noop(){};
  worker.send.apply(worker.send, arguments);

  // Add it back at the end of the array, so we implement a round robin load
  // balancing technique for our workers.
  exports.workers.push(worker);
};

/**
 * Kill all the workers, as we are closing down.
 *
 * @api public
 */
exports.kill = function kill(workers) {
  if (!workers) workers = exports.workers;
  if (!Array.isArray(workers)) workers = [workers];

  workers.forEach(function shutdown(worker) {
    // Remove the worker from the array, so it will not be used again in the
    // `exports#send` method
    var index = exports.workers.indexOf(worker);
    if (~index) exports.workers.splice(index, 1);

    // @TODO Do we need to trigger any queued callbacks? If so with an error?
    worker.queue.length = 0;
    worker.destroy();
  });
};

/**
 * Is our cluster already initialized
 *
 * @type {Boolean}
 * @api private
 */
exports.initialized = false;

/**
 * Detect if the `java` binary is installed on this system. Supporing java
 * allows us to spawn a new childprocess for the closure compiler instead of
 * having to do HTTP requests to the closure api service.
 *
 * @type {String|Boolean}
 * @api private
 */
exports.java = false;
require('which')('java', function which(err, path) {
  if (err) return; // java is not supported on this system

  // we have found the path to the java executable, set it's path for the child
  // process
  exports.java = path;
});

/**
 * Configures a new child process spawn that is used to minify files. We use
 * new child processes for this as these kind of operations are CPU heavy and
 * would block the Node.js event loop resulting in slower conversion rates. This
 * setup also allows us to parallel convert code.
 *
 * @param {Array} args required configuration flags
 * @param {Object} config default configuration
 * @param {String} content content
 * @param {Function} fn callback
 * @api public
 */
exports.jar = function jar(args, config, content, fn) {
  var buffer = ''
    , errors = ''
    , compressor;

  // Generate the --key value options, both the key and the value should added
  // seperately to the `args` array or the child_process will chocke.
  Object.keys(config).filter(function filter(option) {
    return config[option];
  }).forEach(function format(option) {
    var bool = _.isBoolean(config[option]);

    if (!bool || config[option]) {
      args.push('--' + option);
      if (!bool) args.push(config[option]);
    }
  });

  // Spawn the shit and set the correct encoding.
  compressor = spawn(exports.java, args);
  compressor.stdout.setEncoding('utf8');
  compressor.stderr.setEncoding('utf8');

  /**
   * Buffer up the results so we can concat them once the compression is
   * finished.
   *
   * @param {Buffer} chunk
   * @api private
   */
  compressor.stdout.on('data', function data(chunk) {
    buffer += chunk;
  });

  compressor.stderr.on('data', function data(err) {
    errors += err;
  });

  /**
   * The compressor has finished can we now process the data and see if it was
   * a success.
   *
   * @param {Number} code
   * @api private
   */
  compressor.on('close', function close(code) {
    if (errors.length) return fn(new Error(errors));
    if (code !== 0) return fn(new Error('Process exited with code ' + code));
    if (!buffer.length) return fn(new Error('No data returned ' + exports.java + args));

    fn(undefined, buffer);
  });

  // Write out the content that needs to be minified
  compressor.stdin.end(content);
};

/**
 * Maintain a list of our workers. They should be ordered on usage, so we can
 * implement a round robin system by poping and pushing workers after usage.
 *
 * @type {Array}
 * @api private
 */
exports.workers = [];

/**
 * Initialize our cluster.
 *
 * @param {Number} workers
 * @api private
 */
exports.initialize = function initialize(workers) {
  var i = workers || os.cpus().length
    , fork;

  /**
   * Message handler for the workers.
   *
   * @param {Worker} worker
   * @param {Error} err
   * @param {Object} task the updated task
   * @api private
   */
  function message(worker, err, task) {
    var callback = worker.queue[task.id];

    // Kill the whole fucking system, we are in a fucked up state and should die
    // badly, so just throw something and have the process.uncaughtException
    // handle it.
    if (!callback) {
      if (err) console.error(err);
      console.error(task);
      throw new Error('Unable to process message from worker, can\'t locate the callback!');
    }

    callback(err, task);
    delete worker.queue[task.id];
  }

  while (i--) {
    // Configure the forked things
    fork = cluster.fork();
    fork.queue = [];
    fork.on('message', message.bind(message, fork));

    exports.workers.push(fork);
  }

  exports.initialized = true;
};

/**
 * The actual crushers that do the hard work inside this cluster. There are
 * couple of different crushers supported in this cluster:
 *
 * - closure: An interface to the Google Closure Compiler library, it requires
 *   the `java` binary to be installed in system, but gracefully degrades to
 *   their closure service when this is not available.
 * - jsmin: This is one of the earliest minifiers known, it's build by douglas
 *   crockford and does save transformations of the source code.
 * - uglify2: An rewrite of uglify 1, a powerful compiler for JavaScript it's
 *   almost as good as the Google Closure Compiler and in some cases even
 *   better.
 * - yui: The interface to the YUI compressor that was build upon Java. It
 *   requires Java to be installed on the users system or it will savely exit
 *   without compressing the content.
 * - yuglyif: An Yahoo fork of uglify it adds some addition features and fixes
 *   on top of the original uglify compiler.
 * - sqwish: A node.js based CSS compressor, it has the ability to combine
 *   duplicate CSS selectors as well as all the regular compilations.
 *
 * The API for each crusher is the same:
 *
 * @param {String} type the file extension they need to crush
 * @param {Object} collection the details and the data
 * @param {Function} cb error first styled callback
 * @api private
 */
exports.crushers = {
    /**
     * @see https://github.com/mishoo/UglifyJS2
     */
    uglify2: function uglify2(type, collection, cb) {
      if (type !== 'js') return cb(new Error('Type is not supported'));
    }

    /**
     * @see http://www.iteral.com/jscrush
     */
  , jscrush: function jscrush(type, collection, cb) {
      if (type !== 'js') return cb(new Error('Type is not supported'));
      var compiler = jscrush.crush || (jscrush.crush = require('./jscrush'));

      try { cb(undefined, compiler(collection.content)); }
      catch (e) { cb(e); }
    }

    /**
     * @see https://github.com/yui/yuicompressor
     */
  , yui: function yui(type, collection, cb) {
      if (!exports.java) return cb(undefined, collection.content);

      // Don't set the 'charset': 'ascii' option for the YUI compressor, it will
      // break utf-8 chars. Other compilers do require this flag, or they will
      // transform escaped utf-8 chars to real utf-8 chars.
      exports.jar(['-jar', path.join(__dirname, '../../vendor/yui.jar')], {
          'type': type
        , 'line-break': 256
        , 'verbose': false
      }, collection.content, cb);
    }

    /**
     * @see https://developers.google.com/closure/compiler
     */
  , closure: function closure(type, collection, cb) {
      if (type !== 'js') return cb(new Error('Type is not supported'));

      // Check if java is supported on this system, if not we have to use the
      // external closure compiler service to handle all the compilation tasks
      // for us.
      if (!exports.java) return request.post({
          url: 'https://closure-compiler.appspot.com/compile'
        , body: {
              output_format: 'text'                     // we only want the compiled shizzle
            , js_code: collection.content               // the code that needs to be crushed
            , compilation_level: 'SIMPLE_OPTIMIZATIONS' // compression level
            , charset: 'ascii'                          // correct the charset
            , language_in: 'ECMASCRIPT5'                // language
            , warning_level: 'QUIET'                    // stfu warnings
          }
      }, function servicecall(err, req, body) {
        if (err) return cb(err);

        // @TODO check the returned body and / or response code for possible
        // service code failures
        cb(undefined, body);
      });

      // Java is supported on this system, use that instead as it will be
      // cheaper and faster then calling the service.
      exports.jar(['-jar', path.join(__dirname, '../../vendor/closure.jar')], {
          'charset': 'ascii'
        , 'compilation_level': 'SIMPLE_OPTIMIZATIONS'
        , 'language_in': 'ECMASCRIPT5'
        , 'warning_level': 'QUIET'
        , 'jscomp_off': 'uselessCode'
        , 'summary_detail_level': 0
      }, collection.content, cb);
    }

    /**
     * @see https://github.com/yui/yuglify
     */
  , yuglify: function yuglify(type, collection, cb) {
      canihaz.yuglify(function fetch(err, yuglify) {
        if (err) return cb(err);

        yuglify[type === 'js' ? 'jsmin' : 'cssmin'](collection.content, cb);
      });
    }

    /**
     * @see https://github.com/twolfson/node-jsmin-sourcemap
     */
  , jsmin: function jsmin(type, collection, cb) {
      if (type !== 'js') return cb(new Error('Type is not supported'));

      canihaz['jsmin-sourcemap'](function fetch(err, jsmin) {
        if (err) return cb(err);

        try { cb(undefined, jsmin(collection.content).code); }
        catch (e) { return cb(e); }
      });
    }

    /**
     * @see https://github.com/Constellation/esmangle
     */
  , esmangle: function esmangle(type, collection, cb) {
      if (type !== 'js') return cb(new Error('Type is not supported'));

      canihaz.all('esprima', 'escodegen', 'esmangle', function all(err, esprima, escodegen, esmangle) {
        if (err) return cb(err);

        var tree;
        try {
          tree = esprima.parse(collection.content, { loc: true });
          tree = esmangle.optimize(tree, null, {
              destructive: true
            , directive: true
          });
          tree = esmangle.mangle(tree, {
              destructive: true
          });

          cb(undefined, escodegen.generate(tree, {
              format: {
                  renumber: true
                , hexadecimal: true
                , escapeless: true
                , compact: true
                , semicolons: false
                , parentheses: false
              }
            , directive: true
          }));
        } catch(fail) {
          cb(fail);
        }
      });
    }

    /**
     * @see https://github.com/ded/sqwish
     */
  , sqwish: function sqwish(type, collection, cb) {
      if (type !== 'css') return cb(new Error('Type is not supported'));

      canihaz.sqwish(function fetch(err, sqwish) {
        if (err) return cb(err);

        try { cb(undefined, sqwish(collection.content, true)); }
        catch (fail) { cb(fail); }
      });
    }
};

/**
 * The compressors that are able to compile JavaScript.
 *
 * @type {Object}
 * @api private
 */
exports.js = {
    uglify2: exports.crushers.uglify2.bind(exports.crushers, 'js')
  , closure: exports.crushers.closure.bind(exports.crushers, 'js')
  , yuglyif: exports.crushers.yuglyif.bind(exports.crushers, 'js')
  , jsmin: exports.crushers.jsmin.bind(exports.crushers, 'js')
  , esmangle: exports.crushers.esmangle.bind(exports.crushers, 'js')
  , yui: exports.crushers.yui.bind(exports.crushers, 'js')
};

/**
 * The compressors that are able to compile Cascading Style Sheets.
 *
 * @type {Object}
 * @api private
 */
exports.css = {
    yuglyif: exports.crushers.yuglyif.bind(exports.crushers, 'css')
  , sqwish: exports.crushers.sqwish.bind(exports.crushers, 'css')
  , yui: exports.crushers.yui.bind(exports.crushers, 'css')
};
