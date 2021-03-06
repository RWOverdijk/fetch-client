import {HttpClientConfiguration} from './http-client-configuration';
import {RequestInit, Interceptor} from './interfaces';
import 'core-js';

/**
* An HTTP client based on the Fetch API.
*/
export class HttpClient {
  /**
  * The current number of active requests.
  * Requests being processed by interceptors are considered active.
  */
  activeRequestCount: number = 0;

  /**
  * Indicates whether or not the client is currently making one or more requests.
  */
  isRequesting: boolean = false;

  /**
  * Indicates whether or not the client has been configured.
  */
  isConfigured: boolean = false;

  /**
  * The base URL set by the config.
  */
  baseUrl: string = '';

  /**
  * The default request init to merge with values specified at request time.
  */
  defaults: RequestInit = null;

  /**
  * The interceptors to be run during requests.
  */
  interceptors: Interceptor[] = [];

  constructor() {
    if (typeof fetch === 'undefined') {
      throw new Error('HttpClient requires a Fetch API implementation, but the current environment doesn\'t support it. You may need to load a polyfill such as https://github.com/github/fetch.');
    }
  }

  /**
  * Configure this client with default settings to be used by all requests.
  *
  * @param config - A configuration object, or a function that takes a config
  * object and configures it.
  *
  * @chainable
  */
  configure(config: RequestInit|(config: HttpClientConfiguration) => void|HttpClientConfiguration): HttpClient {
    let normalizedConfig;

    if (typeof config === 'object') {
      normalizedConfig = { defaults: config };
    } else if (typeof config === 'function') {
      normalizedConfig = new HttpClientConfiguration();
      let c = config(normalizedConfig);
      if (typeof c === HttpClientConfiguration) {
        normalizedConfig = c;
      }
    } else {
      throw new Error('invalid config');
    }

    let defaults = normalizedConfig.defaults;
    if (defaults && defaults.headers instanceof Headers) {
      // Headers instances are not iterable in all browsers. Require a plain
      // object here to allow default headers to be merged into request headers.
      throw new Error('Default headers must be a plain object.');
    }

    this.baseUrl = normalizedConfig.baseUrl;
    this.defaults = defaults;
    this.interceptors.push(...normalizedConfig.interceptors || []);
    this.isConfigured = true;

    return this;
  }

  /**
  * Starts the process of fetching a resource. Default configuration parameters
  * will be applied to the Request. The constructed Request will be passed to
  * registered request interceptors before being sent. The Response will be passed
  * to registered Response interceptors before it is returned.
  *
  * See also https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
  *
  * @param input - The resource that you wish to fetch. Either a
  * Request object, or a string containing the URL of the resource.
  * @param - An options object containing settings to be applied to
  * the Request.
  */
  fetch(input: Request|string, init?: RequestInit): Promise<Response> {
    this::trackRequestStart();

    let request = Promise.resolve().then(() => this::buildRequest(input, init, this.defaults));
    let promise = processRequest(request, this.interceptors)
      .then(result => {
        let response = null;

        if (result instanceof Response) {
          response = result;
        } else if (result instanceof Request) {
          response = fetch(result);
        } else {
          throw new Error(`An invalid result was returned by the interceptor chain. Expected a Request or Response instance, but got [${result}]`);
        }

        return processResponse(response, this.interceptors);
      });

    return this::trackRequestEndWith(promise);
  }
}

function trackRequestStart() {
  this.isRequesting = !!(++this.activeRequestCount);
}

function trackRequestEnd() {
  this.isRequesting = !!(--this.activeRequestCount);
}

function trackRequestEndWith(promise) {
  let handle = this::trackRequestEnd;
  promise.then(handle, handle);
  return promise;
}

function parseHeaderValues(headers) {
  let parsedHeaders = {};
  for (let name in headers || {}) {
    if (headers.hasOwnProperty(name)) {
      parsedHeaders[name] = (typeof headers[name] === 'function') ? headers[name]() : headers[name];
    }
  }
  return parsedHeaders;
}

function buildRequest(input, init = {}) {
  let defaults = this.defaults || {};
  let source;
  let url;
  let body;

  if (input instanceof Request) {
    if (!this.isConfigured) {
      // don't copy the request if there are no defaults configured
      return input;
    }

    source = input;
    url = input.url;
    body = input.blob();
  } else {
    source = init;
    url = input;
    body = init.body;
  }

  let parsedDefaultHeaders = parseHeaderValues(defaults.headers);
  let requestInit = Object.assign({}, defaults, { headers: {} }, source, { body });
  let request = new Request((this.baseUrl || '') + url, requestInit);
  setDefaultHeaders(request.headers, parsedDefaultHeaders);

  return request;
}

function setDefaultHeaders(headers, defaultHeaders) {
  for (let name in defaultHeaders || {}) {
    if (defaultHeaders.hasOwnProperty(name) && !headers.has(name)) {
      headers.set(name, defaultHeaders[name]);
    }
  }
}

function processRequest(request, interceptors) {
  return applyInterceptors(request, interceptors, 'request', 'requestError');
}

function processResponse(response, interceptors) {
  return applyInterceptors(response, interceptors, 'response', 'responseError');
}

function applyInterceptors(input, interceptors, successName, errorName) {
  return (interceptors || [])
    .reduce((chain, interceptor) => {
      let successHandler = interceptor[successName];
      let errorHandler = interceptor[errorName];

      return chain.then(
        successHandler && interceptor::successHandler,
        errorHandler && interceptor::errorHandler);
    }, Promise.resolve(input));
}
