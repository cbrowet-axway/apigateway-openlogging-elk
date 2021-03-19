const https = require('https');
const requester = require('@axway/requester');

var cache = {};

/**
 * Action method.
 *
 * @param {object} params - A map of all the parameters passed from the flow.
 * @param {object} options - The additional options provided from the flow
 *	 engine.
 * @param {object} options.pluginConfig - The service configuration for this
 *	 plugin from API Builder config.pluginConfig['api-builder-plugin-pluginName']
 * @param {object} options.logger - The API Builder logger which can be used
 *	 to log messages to the console. When run in unit-tests, the messages are
 *	 not logged.  If you wish to test logging, you will need to create a
 *	 mocked logger (e.g. using `simple-mock`) and override in
 *	 `MockRuntime.loadPlugin`.  For more information about the logger, see:
 *	 https://docs.axway.com/bundle/API_Builder_4x_allOS_en/page/logging.html
 * @param {*} [options.pluginContext] - The data provided by passing the
 *	 context to `sdk.load(file, actions, { pluginContext })` in `getPlugin`
 *	 in `index.js`.
 * @return {*} The response value (resolves to "next" output, or if the method
 *	 does not define "next", the first defined output).
 */
async function switchOnAuthZ(params, options) {
	const { logger } = options;
	var authZConfig = options.pluginContext.authZConfig;
	if(!authZConfig) {
		logger.debug(`Using organization based authorization.`);
		return options.setOutput('org', {});
	} else if(authZConfig.externalHTTP) {
		logger.debug(`Using external HTTP based authorization.`);
		return options.setOutput('extHttp', authZConfig.externalHTTP);
	}
	logger.debug(`Using organization based authorization. (Default)`);
	return options.setOutput('org', {});
}

async function addApiManagerOrganizationFilter(params, options) {
	var { user, elasticQuery, indexProperty } = params;
	const { logger } = options;
	if (!user) {
		throw new Error('Missing required parameter: user');
	}
	if (!elasticQuery) {
		throw new Error('Missing required parameter: elasticQuery');
	}
	if (!(user instanceof Object)) {
		throw new Error('Parameter: user must be an object');
	}
	if (typeof elasticQuery != 'object') {
		throw new Error('Parameter: elasticQuery must be an object');
	}
	if(!indexProperty) {
		indexProperty = "serviceContext.apiOrg";
	}
	var filters = elasticQuery.bool.must;
	// Skip, if the user an API-Gateway Admin
	if (!user.gatewayManager.isAdmin) {
		var filter;
		// If the user is an API-Manager Admin, he should see all traffic passed API-Manager (has a ServiceContext)
		if (user.apiManager.role == "admin") {
			// The serviceContext may be at different places depending on the queried index
			filter = {
				bool: {
					should: [
						{ exists: {  "field" : "transactionSummary.serviceContext" } },
						{ exists: {  "field" : "serviceContext" } }
					]
				}
			};
		} else {
			filter = { term: {} };
			filter.term[indexProperty] = user.apiManager.organizationName;
		}
		filters.push(filter);
	}
	return elasticQuery;
}

async function addExtHTTPAuthzFilter(params, options) {
	var { user, elasticQuery } = params;
	const { logger, pluginConfig } = options;
	cache = options.pluginContext.cache;
	var authZConfig = options.pluginContext.authZConfig;
	var responseHandler = options.pluginContext.responseHandler;
	var createRequestUri = options.pluginContext.createRequestUri;
	
	if (!user) {
		throw new Error('Missing required parameter: user');
	}
	if (!elasticQuery) {
		throw new Error('Missing required parameter: elasticQuery');
	}
	if (!(user instanceof Object)) {
		throw new Error('Parameter: user must be an object');
	}
	if (!(elasticQuery instanceof Object)) {
		throw new Error('Parameter: elasticQuery must be an object');
	}
	if(!authZConfig.externalHTTP.uri) {
		throw new Error('Missing configuration: externalHTTP.uri');
	}
	if(!authZConfig.externalHTTP.restrictionField) {
		throw new Error('Missing configuration: externalHTTP.restrictionField');
	}
	if(!authZConfig.externalHTTP.restrictionFieldType) {
		throw new Error('Missing configuration: externalHTTP.restrictionFieldType');
	}
	if(authZConfig.externalHTTP.restrictionFieldType!="custom" && 
		authZConfig.externalHTTP.restrictionFieldType!="select" && 
		authZConfig.externalHTTP.restrictionFieldType!="switch") {
		throw new Error(`Invalid configuration: externalHTTP.restrictionFieldType: ${authZConfig.externalHTTP.restrictionFieldType}`);
	}
	const cacheKey = `ExtAuthZ###${user.loginName}`;
	var cfg = authZConfig.externalHTTP;
	if(!cache.has(cacheKey)) {
		if(createRequestUri) {
			console.log("------------------------------------- URL: " + cfg.uri);
			cfg.replacedUri = await createRequestUri(user, cfg, options);
			logger.debug(`Request URI created: ${cfg.replacedUri}`);
		} else {
			throw new Error(`Missing method: createRequestUri. You have to defined the createRequestUri method to create the request URI.`);
		}
		logger.info(`External groups NOT found in cache with key: '${cacheKey}'. Going to request information from ${cfg.replacedUri}`);
		const resp = await requester(cfg.replacedUri, cfg.headers, cfg.method, cfg.body, { logger, ...cfg.options });
		cache.set(cacheKey, resp);
	} else {
		logger.debug(`External groups found in cache with key: '${cacheKey}'.`);
	}
	var response = cache.get(cacheKey);
	if(!response.body.data || response.body.data.length == 0) {
		return options.setOutput('noAccess', `User: ${user.loginName} has no access`);
	}
	if(responseHandler) {
		elasticQuery = responseHandler(response, elasticQuery, cfg, options);
	} else {
		logger.error(`Missing responseHandler method: handleResponse`);
	}
	return elasticQuery;
}

module.exports = {
	addApiManagerOrganizationFilter, 
	addExtHTTPAuthzFilter,
	switchOnAuthZ
};
