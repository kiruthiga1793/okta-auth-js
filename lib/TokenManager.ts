/*!
 * Copyright (c) 2015-present, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */
/* global localStorage, sessionStorage */
/* eslint complexity:[0,8] max-statements:[0,21] */
import { removeNils, warn, isObject } from './util';
import AuthSdkError from './errors/AuthSdkError';
import storageUtil from './browser/browserStorage';
import { TOKEN_STORAGE_NAME } from './constants';
import storageBuilder from './storageBuilder';
import SdkClock from './clock';
import { Token, TokenManagerOptions, isIDToken, isAccessToken } from './types';

var DEFAULT_OPTIONS = {
  autoRenew: true,
  storage: 'localStorage',
  expireEarlySeconds: 30
};

function getExpireTime(tokenMgmtRef, token) {
  var expireTime = token.expiresAt - tokenMgmtRef.options.expireEarlySeconds;
  return expireTime;
}

function hasExpired(tokenMgmtRef, token) {
  var expireTime = getExpireTime(tokenMgmtRef, token);
  return expireTime <= tokenMgmtRef.clock.now();
}

function emitExpired(tokenMgmtRef, key, token) {
  tokenMgmtRef.emitter.emit('expired', key, token);
}

function emitRemoved(tokenMgmtRef, key) {
  tokenMgmtRef.emitter.emit('removed', key);
}

function emitError(tokenMgmtRef, error) {
  tokenMgmtRef.emitter.emit('error', error);
}

function clearExpireEventTimeout(tokenMgmtRef, key) {
  clearTimeout(tokenMgmtRef.expireTimeouts[key]);
  delete tokenMgmtRef.expireTimeouts[key];

  // Remove the renew promise (if it exists)
  delete tokenMgmtRef.renewPromise[key];
}

function clearExpireEventTimeoutAll(tokenMgmtRef) {
  var expireTimeouts = tokenMgmtRef.expireTimeouts;
  for (var key in expireTimeouts) {
    if (!Object.prototype.hasOwnProperty.call(expireTimeouts, key)) {
      continue;
    }
    clearExpireEventTimeout(tokenMgmtRef, key);
  }
}

function setExpireEventTimeout(sdk, tokenMgmtRef, key, token) {
  var expireTime = getExpireTime(tokenMgmtRef, token);
  var expireEventWait = Math.max(expireTime - tokenMgmtRef.clock.now(), 0) * 1000;

  // Clear any existing timeout
  clearExpireEventTimeout(tokenMgmtRef, key);

  var expireEventTimeout = setTimeout(function() {
    emitExpired(tokenMgmtRef, key, token);
  }, expireEventWait);

  // Add a new timeout
  tokenMgmtRef.expireTimeouts[key] = expireEventTimeout;
}

function setExpireEventTimeoutAll(sdk, tokenMgmtRef, storage) {
  try {
    var tokenStorage = storage.getStorage();
  } catch(e) {
    // Any errors thrown on instantiation will not be caught,
    // because there are no listeners yet
    emitError(tokenMgmtRef, e);
    return;
  }

  for(var key in tokenStorage) {
    if (!Object.prototype.hasOwnProperty.call(tokenStorage, key)) {
      continue;
    }
    var token = tokenStorage[key];
    setExpireEventTimeout(sdk, tokenMgmtRef, key, token);
  }
}

function add(sdk, tokenMgmtRef, storage, key, token: Token) {
  var tokenStorage = storage.getStorage();
  if (!isObject(token) ||
      !token.scopes ||
      (!token.expiresAt && token.expiresAt !== 0) ||
      (!isIDToken(token) && !isAccessToken(token))) {
    throw new AuthSdkError('Token must be an Object with scopes, expiresAt, and an idToken or accessToken properties');
  }
  tokenStorage[key] = token;
  storage.setStorage(tokenStorage);
  setExpireEventTimeout(sdk, tokenMgmtRef, key, token);
}

function get(storage, key) {
  var tokenStorage = storage.getStorage();
  return tokenStorage[key];
}

function getAsync(sdk, tokenMgmtRef, storage, key) {
  return new Promise(function(resolve) {
    var token = get(storage, key);
    return resolve(token);
  });
}

function remove(tokenMgmtRef, storage, key) {
  // Clear any listener for this token
  clearExpireEventTimeout(tokenMgmtRef, key);

  // Remove it from storage
  var tokenStorage = storage.getStorage();
  delete tokenStorage[key];
  storage.setStorage(tokenStorage);

  emitRemoved(tokenMgmtRef, key);
}

function renew(sdk, tokenMgmtRef, storage, key) {
  // Multiple callers may receive the same promise. They will all resolve or reject from the same request.
  var existingPromise = tokenMgmtRef.renewPromise[key];
  if (existingPromise) {
    return existingPromise;
  }

  try {
    var token = get(storage, key);
    if (!token) {
      throw new AuthSdkError('The tokenManager has no token for the key: ' + key);
    }
  } catch (e) {
    return Promise.reject(e);
  }

  // Remove existing autoRenew timeout for this key
  clearExpireEventTimeout(tokenMgmtRef, key);

  // Store the renew promise state, to avoid renewing again
  tokenMgmtRef.renewPromise[key] = sdk.token.renew(token)
    .then(function(freshToken) {
      var oldToken = get(storage, key);
      if (!oldToken) {
        // It is possible to enter a state where the tokens have been cleared
        // after a renewal request was triggered. To ensure we do not store a
        // renewed token, we verify the promise key doesn't exist and return.
        return;
      }
      add(sdk, tokenMgmtRef, storage, key, freshToken);
      tokenMgmtRef.emitter.emit('renewed', key, freshToken, oldToken);
      return freshToken;
    })
    .catch(function(err) {
      if (err.name === 'OAuthError' || err.name === 'AuthSdkError') {
        remove(tokenMgmtRef, storage, key);
        err.tokenKey = key;
        err.accessToken = !!token.accessToken;
        emitError(tokenMgmtRef, err);
      }
      throw err;
    })
    .finally(function() {
      // Remove existing promise key
      delete tokenMgmtRef.renewPromise[key];
    });

  return tokenMgmtRef.renewPromise[key];
}

function clear(tokenMgmtRef, storage) {
  clearExpireEventTimeoutAll(tokenMgmtRef);
  storage.clearStorage();
}

export class TokenManager {
  get: (key: string) => Promise<Token>;
  add: (key: string, token: Token) => void;
  clear: () => void;
  remove: (key: string) => void;
  renew: (key: string) => Promise<Token>;
  on: (event: string, handler: Function, context?: object) => void;
  off: (event: string, handler: Function) => void;
  hasExpired: (token: Token) => boolean;

  constructor(sdk, options: TokenManagerOptions) {
    options = Object.assign({}, DEFAULT_OPTIONS, removeNils(options));

    if (options.storage === 'localStorage' && !storageUtil.browserHasLocalStorage()) {
      warn('This browser doesn\'t support localStorage. Switching to sessionStorage.');
      options.storage = 'sessionStorage';
    }

    if (options.storage === 'sessionStorage' && !storageUtil.browserHasSessionStorage()) {
      warn('This browser doesn\'t support sessionStorage. Switching to cookie-based storage.');
      options.storage = 'cookie';
    }

    var storageProvider;
    if (typeof options.storage === 'object') {
      // A custom storage provider must implement getItem(key) and setItem(key, val)
      storageProvider = options.storage;
    } else {
      switch(options.storage) {
        case 'localStorage':
          storageProvider = localStorage;
          break;
        case 'sessionStorage':
          storageProvider = sessionStorage;
          break;
        case 'cookie':
          // Implement customized cookie storage to make sure each token is stored separatedly in cookie
          storageProvider = (function(options) {
            var storage = storageUtil.getCookieStorage(options);
            return {
              getItem: function(key) {
                var data = storage.getItem();
                var value = {};
                Object.keys(data).forEach(k => {
                  if (k.indexOf(key) === 0) {
                    value[k.replace(`${key}_`, '')] = JSON.parse(data[k]);
                  }
                });
                return JSON.stringify(value);
              },
              setItem: function(key, value) {
                var existingValues = JSON.parse(this.getItem(key));
                value = JSON.parse(value);
                // Set key-value pairs from input to cookies
                Object.keys(value).forEach(k => {
                  var storageKey = key + '_' + k;
                  var valueToStore = JSON.stringify(value[k]);
                  storage.setItem(storageKey, valueToStore);
                  delete existingValues[k];
                });
                // Delete unmatched keys from existing cookies
                Object.keys(existingValues).forEach(k => {
                  storageUtil.storage.delete(key + '_' + k);
                });
              }
            };
          }(sdk.options.cookies));
          break;
        case 'memory':
          storageProvider = storageUtil.getInMemoryStorage();
          break;
        default:
          throw new AuthSdkError('Unrecognized storage option');
      }
    }
    var storageKey = options.storageKey || TOKEN_STORAGE_NAME;
    var storage = storageBuilder(storageProvider, storageKey);
    var clock = SdkClock.create(/* sdk, options */);
    var tokenMgmtRef = {
      clock: clock,
      options: options,
      emitter: sdk.emitter,
      expireTimeouts: {},
      renewPromise: {}
    };

    this.add = add.bind(this, sdk, tokenMgmtRef, storage);
    this.get = getAsync.bind(this, sdk, tokenMgmtRef, storage);
    this.remove = remove.bind(this, tokenMgmtRef, storage);
    this.clear = clear.bind(this, tokenMgmtRef, storage);
    this.renew = renew.bind(this, sdk, tokenMgmtRef, storage);
    this.on = tokenMgmtRef.emitter.on.bind(tokenMgmtRef.emitter);
    this.off = tokenMgmtRef.emitter.off.bind(tokenMgmtRef.emitter);
    this.hasExpired = hasExpired.bind(this, tokenMgmtRef);
  
    const onTokenExpiredHandler = (key) => {
      if (options.autoRenew) {
        this.renew(key).catch(() => {}); // Renew errors will emit an "error" event 
      } else {
        this.remove(key);
      }
    };
    this.on('expired', onTokenExpiredHandler);

    setExpireEventTimeoutAll(sdk, tokenMgmtRef, storage);
  }
}
