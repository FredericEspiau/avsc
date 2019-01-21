/* jshint esversion: 6, mocha: true, node: true */

'use strict';

const {Client, Server} = require('../lib/call');
const {Context} = require('../lib/context');
const {Service} = require('../lib/service');
const {Router} = require('../lib/router');

const assert = require('assert');
const {Type} = require('avsc');
const backoff = require('backoff');
const sinon = require('sinon');

suite('router', () => {
  const echoSvc = new Service({
    protocol: 'Echo',
    messages: {
      echo: {
        request: [{name: 'message', type: 'string'}],
        response: 'string',
      },
    },
  });
  const upperSvc = new Service({
    protocol: 'foo.Upper',
    messages: {
      upper: {
        request: [{name: 'message', type: 'string'}],
        response: 'string',
        errors: [
          {name: 'UpperError', type: 'error', fields: []},
        ],
      },
    },
  });

  suite('router', () => {
    test('single service', (done) => {
      const echoServer = new Server(echoSvc)
        .onMessage().echo((str, cb) => { cb(null, str); });
      const router = Router.forServers([echoServer]);
      const echoClient = new Client(echoSvc);
      echoClient.channel = router.channel;
      const upperClient = new Client(upperSvc);
      upperClient.channel = router.channel;
      echoClient.emitMessage(new Context()).echo('foo', (err, res) => {
        assert(!err, err);
        assert.equal(res, 'foo');
        upperClient.emitMessage(new Context()).upper('bar', (err, res) => {
          assert.equal(err.code, 'ERR_AVRO_SERVICE_NOT_FOUND');
          done();
        });
      });
    });

    test('two services', (done) => {
      const echoServer = new Server(echoSvc)
        .onMessage().echo((str, cb) => { cb(null, str); });
      const upperServer = new Server(upperSvc);
      const router = Router.forServers([echoServer, upperServer]);
      const echoClient = new Client(echoSvc);
      echoClient.channel = router.channel;
      echoClient.emitMessage(new Context()).echo('foo', (err, res) => {
        assert(!err, err);
        assert.equal(res, 'foo');
        done();
      });
    });
  });
});