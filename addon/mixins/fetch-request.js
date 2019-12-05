import { A } from '@ember/array';
import EmberError from '@ember/error';
import Mixin from '@ember/object/mixin';
import { assign } from '@ember/polyfills';
import { get } from '@ember/object';
import { isEmpty } from '@ember/utils';
import fetch from 'fetch';
import param from 'jquery-param';
import {
  isAbortError,
  isBadRequestResponse,
  isConflictResponse,
  isForbiddenResponse,
  isGoneResponse,
  isInvalidResponse,
  isNotFoundResponse,
  isServerErrorResponse,
  isUnauthorizedResponse
} from 'ember-fetch/errors';
import {
  FetchError,
  UnauthorizedError,
  InvalidError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
  GoneError,
  AbortError,
  ConflictError,
  ServerError
} from 'ember-ajax-fetch/errors';
import {
  haveSameHost,
  isFullURL,
  parseURL
} from 'ember-ajax-fetch/-private/utils/url-helpers';
import isString from 'ember-ajax-fetch/-private/utils/is-string';
import { parseJSON } from 'ember-ajax-fetch/-private/utils/json-helpers';

/**
 * @class FetchRequestMixin
 */
export default Mixin.create({
  /**
   * The default value for the request `contentType`
   *
   * For now, defaults to the same value that jQuery would assign.  In the
   * future, the default value will be for JSON requests.
   * @property {string} contentType
   * @public
   */
  contentType: 'application/x-www-form-urlencoded; charset=UTF-8',

  /**
   * @method request
   * @param {string} url
   * @param {object} options
   * @return {Promise<*>}
   */
  async request(url, options = {}) {
    const hash = this.options(url, options);
    const method = hash.method || hash.type || 'GET';
    const requestOptions = {
      method,
      headers: {
        'Content-Type': hash.contentType,
        ...(hash.headers || {})
      }
    };

    let builtURL = hash.url;
    if (hash.data) {
      let { data } = hash;

      if (isJsonString(data)) {
        data = JSON.parse(data);
      }

      if (requestOptions.method === 'GET') {
        builtURL = `${builtURL}?${param(data)}`;
      } else {
        requestOptions.body = JSON.stringify(data);
      }
    }

    try {
      let response = await fetch(builtURL, requestOptions);
      response = await parseJSON(response);

      return this._handleResponse(response, requestOptions, builtURL);
    } catch(error) {
      // TODO: do we want to just throw here or should some errors be okay?
      throw error;
    }
  },

  /**
   * Determine whether the headers should be added for this request
   *
   * This hook is used to help prevent sending headers to every host, regardless
   * of the destination, since this could be a security issue if authentication
   * tokens are accidentally leaked to third parties.
   *
   * To avoid that problem, subclasses should utilize the `headers` computed
   * property to prevent authentication from being sent to third parties, or
   * implement this hook for more fine-grain control over when headers are sent.
   *
   * By default, the headers are sent if the host of the request matches the
   * `host` property designated on the class.
   */
  _shouldSendHeaders({ url, host }) {
    url = url || '';
    host = host || get(this, 'host') || '';

    const trustedHosts = get(this, 'trustedHosts') || A();
    const { hostname } = parseURL(url);

    // Add headers on relative URLs
    if (!isFullURL(url)) {
      return true;
    } else if (
      trustedHosts.find(matcher => this._matchHosts(hostname, matcher))
    ) {
      return true;
    }

    // Add headers on matching host
    return haveSameHost(url, host);
  },

  /**
   * Generates a detailed ("friendly") error message, with plenty
   * of information for debugging (good luck!)
   */
  generateDetailedMessage(
    status,
    payload,
    contentType,
    type,
    url
  ) {
    let shortenedPayload;
    const payloadContentType =
      contentType || 'Empty Content-Type';

    if (
      payloadContentType.toLowerCase() === 'text/html' &&
      payload.length > 250
    ) {
      shortenedPayload = '[Omitted Lengthy HTML]';
    } else {
      shortenedPayload = JSON.stringify(payload);
    }

    const requestDescription = `${type} ${url}`;
    const payloadDescription = `Payload (${payloadContentType})`;

    return [
      `Ember Ajax Fetch Request ${requestDescription} returned a ${status}`,
      payloadDescription,
      shortenedPayload
    ].join('\n');
  },

  /**
   * Created a normalized set of options from the per-request and
   * service-level settings
   * @param {string} url
   * @param {object} options
   * @return {object}
   */
  options(url, options = {}) {
    options = assign({}, options);
    options.url = this._buildURL(url, options);
    options.type = options.type || 'GET';
    options.dataType = options.dataType || 'json';
    options.contentType = isEmpty(options.contentType)
      ? get(this, 'contentType')
      : options.contentType;

    if (this._shouldSendHeaders(options)) {
      options.headers = this._getFullHeadersHash(options.headers);
    } else {
      options.headers = options.headers || {};
    }

    return options;
  },

  /**
   * Build the URL to pass to `fetch`
   * @param {string} url The base url
   * @param {object} options The options to pass to fetch, query params, headers, etc
   * @return {string} The built url
   * @private
   */
  _buildURL(url, options = {}) {
    if (isFullURL(url)) {
      return url;
    }

    const urlParts = [];

    let host = options.host || get(this, 'host');
    if (host) {
      host = endsWithSlash(host) ? removeTrailingSlash(host) : host;
      urlParts.push(host);
    }

    let namespace = options.namespace || get(this, 'namespace');
    if (namespace) {
      // If host is given then we need to strip leading slash too( as it will be added through join)
      if (host) {
        namespace = stripSlashes(namespace);
      } else if (endsWithSlash(namespace)) {
        namespace = removeTrailingSlash(namespace);
      }

      const hasNamespaceRegex = new RegExp(`^(/)?${stripSlashes(namespace)}/`);
      if (!hasNamespaceRegex.test(url)) {
        urlParts.push(namespace);
      }
    }

    // *Only* remove a leading slash -- we need to maintain a trailing slash for
    // APIs that differentiate between it being and not being present
    if (startsWithSlash(url) && urlParts.length !== 0) {
      url = removeLeadingSlash(url);
    }
    urlParts.push(url);

    return urlParts.join('/');
  },

  /**
   * Return the correct error type
   * @param response The response from the fetch call
   * @param payload The response.json() payload
   * @param {object} requestOptions The options object containing headers, method, etc
   * @param {string} url The url string
   * @private
   */
  _createCorrectError(response, payload, requestOptions, url) {
    let error;

    if (isUnauthorizedResponse(response)) {
      error = new UnauthorizedError(payload);
    } else if (isForbiddenResponse(response)) {
      error = new ForbiddenError(payload);
    } else if (isInvalidResponse(response)) {
      error = new InvalidError(payload);
    } else if (isBadRequestResponse(response)) {
      error = new BadRequestError(payload);
    } else if (isNotFoundResponse(response)) {
      error = new NotFoundError(payload);
    } else if (isGoneResponse(response)) {
      error = new GoneError(payload);
    } else if (isAbortError(response)) {
      error = new AbortError();
    } else if (isConflictResponse(response)) {
      error = new ConflictError(payload);
    } else if (isServerErrorResponse(response)) {
      error = new ServerError(payload, response.status);
    } else {
      const detailedMessage = this.generateDetailedMessage(
        response.status,
        payload,
        requestOptions.headers['Content-Type'],
        requestOptions.method,
        url
      );

      error = new FetchError(payload, detailedMessage, response.status);
    }

    return error;
  },

  /**
   * calls `request()` but forces `options.type` to `POST`
   * @param {string} url
   * @param {object} options
   * @return {*|Promise<*>}
   */
  post(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'POST'));
  },

  /**
   * calls `request()` but forces `options.type` to `PUT`
   * @param {string} url
   * @param {object} options
   * @return {*|Promise<*>}
   */
  put(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'PUT'));
  },

  /**
   * calls `request()` but forces `options.type` to `PATCH`
   * @param {string} url
   * @param {object} options
   * @return {*|Promise<*>}
   */
  patch(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'PATCH'));
  },

  /**
   * calls `request()` but forces `options.type` to `DELETE`
   * @param {string} url
   * @param {object} options
   * @return {*|Promise<*>}
   */
  del(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'DELETE'));
  },

  /**
   * calls `request()` but forces `options.type` to `DELETE`
   *
   * Alias for `del()`
   * @param {string} url
   * @param {object} options
   * @return {*|Promise<*>}
   */
  delete(url, options) {
    return this.del(url, options);
  },

  /**
   * Wrap the `.get` method so that we issue a warning if
   *
   * Since `.get` is both an AJAX pattern _and_ an Ember pattern, we want to try
   * to warn users when they try using `.get` to make a request
   * @param url
   * @returns {*}
   */
  get(url) {
    if (arguments.length > 1 || url.indexOf('/') !== -1) {
      throw new EmberError(
        'It seems you tried to use `.get` to make a request! Use the `.request` method instead.'
      );
    }
    return this._super(...arguments);
  },

  /**
   * Manipulates the options hash to include the HTTP method on the type key
   */
  _addTypeToOptionsFor(options, method) {
    options = options || {};
    options.type = method;
    return options;
  },

  /**
   * Get the full "headers" hash, combining the service-defined headers with
   * the ones provided for the request
   */
  _getFullHeadersHash(headers) {
    const classHeaders = get(this, 'headers');
    return assign({}, classHeaders, headers);
  },

  /**
   * Return the response or handle the error
   * @param response
   * @param {object} requestOptions The options object containing headers, method, etc
   * @param {string} url The url for the request
   * @return {*}
   * @private
   */
  _handleResponse(response, requestOptions, url) {
    if (response.ok) {
      return response.json;
    } else {
      throw this._createCorrectError(response, response, requestOptions, url);
    }
  },

  /**
   * Match the host to a provided array of strings or regexes that can match to a host
   * @param {string|undefined} host
   * @param {string} matcher
   * @private
   */
  _matchHosts(host, matcher) {
    if (!isString(host)) {
      return false;
    }

    if (matcher instanceof RegExp) {
      return matcher.test(host);
    } else if (typeof matcher === 'string') {
      return matcher === host;
    } else {
      console.warn(
        'trustedHosts only handles strings or regexes. ',
        matcher,
        ' is neither.'
      );
      return false;
    }
  }
});

function isJsonString(str) {
  try {
    const json = JSON.parse(str);
    return (typeof json === 'object');
  } catch(e) {
    return false;
  }
}

function startsWithSlash(string) {
  return string.charAt(0) === '/';
}

function endsWithSlash(string) {
  return string.charAt(string.length - 1) === '/';
}

function removeLeadingSlash(string) {
  return string.substring(1);
}

function removeTrailingSlash(string) {
  return string.slice(0, -1);
}

function stripSlashes(path) {
  // make sure path starts with `/`
  if (startsWithSlash(path)) {
    path = removeLeadingSlash(path);
  }

  // remove end `/`
  if (endsWithSlash(path)) {
    path = removeTrailingSlash(path);
  }
  return path;
}
