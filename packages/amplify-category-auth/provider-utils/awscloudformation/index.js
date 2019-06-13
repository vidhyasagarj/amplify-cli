const inquirer = require('inquirer');
const opn = require('opn');
const _ = require('lodash');


let serviceMetadata;

// Todo: move these to supported service.json

const ENV_SPECIFIC_PARAMS = [
  'facebookAppId',
  'facebookAppIdUserPool',
  'facebookAppSecretUserPool',
  'googleClientId',
  'googleIos',
  'googleAndroid',
  'googleAppIdUserPool',
  'googleAppSecretUserPool',
  'amazonAppId',
  'loginwithamazonAppIdUserPool',
  'loginwithamazonAppSecretUserPool',
  'hostedUIProviderCreds',
];

const safeDefaults = [
  'allowUnauthenticatedIdentities',
  'thirdPartyAuth',
  'authProviders',
  'smsAuthenticationMessage',
  'emailVerificationSubject',
  'emailVerificationMessage',
  'smsVerificationMessage',
  'passwordPolicyMinLength',
  'passwordPolicyCharacters',
  'userpoolClientRefreshTokenValidity',
];

const protectedValues = [
  'resourceName',
  'userPoolName',
  'identityPoolName',
  'usernameAttributes',
  'autoVerifiedAttributes',
  'requiredAttributes',
];

const privateKeys = [
  'facebookAppIdUserPool',
  'facebookAuthorizeScopes',
  'facebookAppSecretUserPool',
  'googleAppIdUserPool',
  'googleAuthorizeScopes',
  'googleAppSecretUserPool',
  'loginwithamazonAppIdUserPool',
  'loginwithamazonAuthorizeScopes',
  'loginwithamazonAppSecretUserPool',
  'CallbackURLs',
  'LogoutURLs',
  'AllowedOAuthFlows',
  'AllowedOAuthScopes',
  'EditURLS',
  'newCallbackURLs',
  'addCallbackOnUpdate',
  'updateFlow',
  'newCallbackURLs',
  'selectedParties',
  'newLogoutURLs',
  'editLogoutURLs',
  'addLogoutOnUpdate',
  'audiences',
];

function serviceQuestions(
  context,
  defaultValuesFilename,
  stringMapFilename,
  serviceWalkthroughFilename,
) {
  const serviceWalkthroughSrc = `${__dirname}/service-walkthroughs/${serviceWalkthroughFilename}`;
  const { serviceWalkthrough } = require(serviceWalkthroughSrc);

  return serviceWalkthrough(context, defaultValuesFilename, stringMapFilename, serviceMetadata);
}

async function copyCfnTemplate(context, category, options, cfnFilename) {
  const { amplify } = context;
  const targetDir = amplify.pathManager.getBackendDirPath();
  const pluginDir = __dirname;

  const copyJobs = [
    {
      dir: pluginDir,
      template: `cloudformation-templates/${cfnFilename}`,
      target: `${targetDir}/${category}/${options.resourceName}/${
        options.resourceName
      }-cloudformation-template.yml`,
      paramsFile: `${targetDir}/${category}/${options.resourceName}/parameters.json`,
    },
  ];

  // copy over the files
  // Todo: move to provider as each provider should decide where to store vars, and cfn
  return await context.amplify.copyBatch(context, copyJobs, options, true, false, privateKeys);
}

function saveResourceParameters(
  context,
  providerName,
  category,
  resource,
  params,
  envSpecificParams = [],
) {
  const provider = context.amplify.getPluginInstance(context, providerName);
  provider.saveResourceParameters(
    context,
    category,
    resource,
    params,
    envSpecificParams,
    privateKeys,
  );
}

async function addResource(context, category, service) {
  let props = {};
  serviceMetadata = context.amplify.readJsonFile(`${__dirname}/../supported-services.json`)[service];
  const {
    cfnFilename,
    defaultValuesFilename,
    stringMapFilename,
    serviceWalkthroughFilename,
    provider,
  } = serviceMetadata;
  let projectName = context.amplify.getProjectConfig().projectName.toLowerCase();
  const disallowedChars = /[^A-Za-z0-9]+/g;
  projectName = projectName.replace(disallowedChars, '');

  return serviceQuestions(
    context,
    defaultValuesFilename,
    stringMapFilename,
    serviceWalkthroughFilename,
  )
    .then(async (result) => {
      const defaultValuesSrc = `${__dirname}/assets/${defaultValuesFilename}`;
      const {
        functionMap,
        generalDefaults,
        getAllDefaults,
        roles,
      } = require(defaultValuesSrc);

      /* if user has used the default configuration,
       * we populate base choices like authSelections and resourceName for them */
      if (['default', 'defaultSocial', 'defaultTriggers'].includes(result.useDefault)) {
        result = Object.assign(generalDefaults(projectName), result);
      }

      /* merge actual answers object into props object,
       * ensuring that manual entries override defaults */
      props = Object.assign(functionMap[result.authSelections](result.resourceName), result, roles);

      await lambdaTriggers(props, context, null, getAllDefaults);

      await copyCfnTemplate(context, category, props, cfnFilename);
      saveResourceParameters(
        context,
        provider,
        category,
        result.resourceName,
        props,
        ENV_SPECIFIC_PARAMS,
      );
    })
    .then(() => {
      if (props.dependsOn) {
        context.amplify.auth = { dependsOn: props.dependsOn };
      }
      return props.resourceName;
    });
}

async function updateResource(context, category, serviceResult) {
  const { service, resourceName } = serviceResult;
  let props = {};
  serviceMetadata = context.amplify.readJsonFile(`${__dirname}/../supported-services.json`)[service];
  const {
    cfnFilename,
    defaultValuesFilename,
    stringMapFilename,
    serviceWalkthroughFilename,
    provider,
  } = serviceMetadata;

  return serviceQuestions(
    context,
    defaultValuesFilename,
    stringMapFilename,
    serviceWalkthroughFilename,
  )
    .then(async (result) => {
      const defaultValuesSrc = `${__dirname}/assets/${defaultValuesFilename}`;
      const { functionMap, getAllDefaults } = require(defaultValuesSrc);
      const { authProviders } = require(`${__dirname}/assets/string-maps.js`);

      /* if user has used the default configuration,
       * we populate base choices like authSelections and resourceName for them */
      if (!result.authSelections) {
        result.authSelections = 'identityPoolAndUserPool';
      }

      const defaults = functionMap[result.authSelections](context.updatingAuth.resourceName);

      // removing protected values from results
      for (let i = 0; i < protectedValues.length; i += 1) {
        if (context.updatingAuth[protectedValues[i]]) {
          delete result[protectedValues[i]];
        }
      }

      if (result.useDefault && ['default', 'defaultSocial', 'defaultTriggers'].includes(result.useDefault)) {
        for (let i = 0; i < safeDefaults.length; i += 1) {
          delete context.updatingAuth[safeDefaults[i]];
        }
      }

      props = Object.assign(defaults, context.updatingAuth, result);

      const providerPlugin = context.amplify.getPluginInstance(context, provider);
      const previouslySaved = providerPlugin.loadResourceParameters(context, 'auth', resourceName).authTriggers || '{}';
      await lambdaTriggers(props, context, JSON.parse(previouslySaved), getAllDefaults);

      if (
        (!result.updateFlow && !result.thirdPartyAuth) ||
        (result.updateFlow === 'manual' && !result.thirdPartyAuth)
      ) {
        delete props.selectedParties;
        delete props.authProviders;
        authProviders.forEach((a) => {
          if (props[a.answerHashKey]) {
            delete props[a.answerHashKey];
          }
        });
        if (props.googleIos) {
          delete props.googleIos;
        }
        if (props.googleAndroid) {
          delete props.googleAndroid;
        }
        if (props.audiences) {
          delete props.audiences;
        }
      }

      if (props.useDefault === 'default' || props.hostedUI === false) {
        delete props.oAuthMetadata;
        delete props.hostedUIProviderMeta;
        delete props.hostedUIProviderCreds;
        delete props.hostedUIDomainName;
        delete props.authProvidersUserPool;
      }

      await copyCfnTemplate(context, category, props, cfnFilename);
      saveResourceParameters(context, provider, category, resourceName, props, ENV_SPECIFIC_PARAMS);
    })
    .then(() => {
      if (props.dependsOn) {
        context.amplify.auth = { dependsOn: props.dependsOn };
      }
      return props.resourceName;
    });
}

async function updateConfigOnEnvInit(context, category, service) {
  const srvcMetaData = context.amplify.readJsonFile(`${__dirname}/../supported-services.json`)
    .Cognito;
  const { defaultValuesFilename, stringMapFilename, serviceWalkthroughFilename } = srvcMetaData;

  const providerPlugin = context.amplify.getPluginInstance(context, srvcMetaData.provider);
  // previously selected answers
  const resourceParams = providerPlugin.loadResourceParameters(context, 'auth', service);
  // ask only env specific questions
  let currentEnvSpecificValues = context.amplify.loadEnvResourceParameters(
    context,
    category,
    service,
  );

  // headless mode
  if (isInHeadlessMode(context)) {
    const envParams = {};
    let mergedValues;
    if (resourceParams.thirdPartyAuth || resourceParams.hostedUIProviderMeta) {
      const authParams = getHeadlessParams(context);
      const projectType = context.amplify.getProjectConfig().frontend;
      mergedValues = { ...resourceParams, ...authParams };
      const requiredParams = getRequiredParamsForHeadlessInit(projectType, resourceParams);
      const missingParams = [];
      requiredParams.forEach((p) => {
        if (Object.keys(mergedValues).includes(p)) {
          envParams[p] = mergedValues[p];
        } else {
          missingParams.push(p);
        }
      });

      if (missingParams.length) {
        throw Error(`auth headless init is missing the following inputParams ${missingParams.join(', ')}`);
      }
    }
    if (resourceParams.hostedUIProviderMeta) {
      parseCredsForHeadless(mergedValues, envParams);
    }
    return envParams;
  }

  const { hostedUIProviderMeta } = resourceParams;

  if (hostedUIProviderMeta) {
    currentEnvSpecificValues = getOAuthProviderKeys(currentEnvSpecificValues, resourceParams);
  }

  srvcMetaData.inputs = srvcMetaData.inputs.filter(input =>
    ENV_SPECIFIC_PARAMS.includes(input.key) &&
    !Object.keys(currentEnvSpecificValues).includes(input.key));
  const serviceWalkthroughSrc = `${__dirname}/service-walkthroughs/${serviceWalkthroughFilename}`;
  const { serviceWalkthrough } = require(serviceWalkthroughSrc);

  // interactive mode
  const result = await serviceWalkthrough(
    context,
    defaultValuesFilename,
    stringMapFilename,
    srvcMetaData,
    resourceParams,
  );
  let envParams = {};
  if (resourceParams.hostedUIProviderMeta) {
    envParams = formatCredsforEnvParams(currentEnvSpecificValues, result, resourceParams);
  }
  ENV_SPECIFIC_PARAMS.forEach((paramName) => {
    if (paramName in result &&
      paramName !== 'hostedUIProviderCreds' &&
      privateKeys.indexOf(paramName) === -1) {
      envParams[paramName] = result[paramName];
    }
  });
  return envParams;
}

async function migrate(context) {
  const category = 'auth';
  const { amplify } = context;
  const existingAuth = context.migrationInfo.amplifyMeta.auth || {};
  if (!Object.keys(existingAuth).length > 0) {
    return;
  }
  const servicesMetadata = amplify.readJsonFile(`${__dirname}/../../provider-utils/supported-services.json`);
  const { provider, cfnFilename, defaultValuesFilename } = servicesMetadata.Cognito;
  const defaultValuesSrc = `${__dirname}/assets/${defaultValuesFilename}`;

  const { roles } = require(defaultValuesSrc);

  const providerInstance = amplify.getPluginInstance(context, provider);
  const resourceName = Object.keys(existingAuth)[0];
  const props = providerInstance.loadResourceParameters(context, 'auth', resourceName);
  // Roles have changed to ref. Removing old hardcoded role ref
  Object.keys(roles).forEach((key) => {
    delete props[key];
  });
  await copyCfnTemplate(context, category, props, cfnFilename);
  saveResourceParameters(
    context,
    provider,
    category,
    resourceName,
    { ...roles, ...props },
    ENV_SPECIFIC_PARAMS,
  );
}

function isInHeadlessMode(context) {
  return context.exeInfo.inputParams.yes;
}

function getHeadlessParams(context) {
  const { inputParams } = context.exeInfo;
  const { categories = {} } = inputParams;
  return categories.auth || {};
}

function getOAuthProviderKeys(currentEnvSpecificValues, resourceParams) {
  const oAuthProviders = JSON.parse(resourceParams.hostedUIProviderMeta).map(h => h.ProviderName);
  const { hostedUIProviderCreds = '[]' } = currentEnvSpecificValues;
  const configuredProviders = JSON.parse(hostedUIProviderCreds).map(h => h.ProviderName);
  const deltaProviders = _.intersection(oAuthProviders, configuredProviders);
  deltaProviders.forEach((d) => {
    currentEnvSpecificValues[`${d.toLowerCase()}AppIdUserPool`] = configuredProviders[`${d.toLowerCase()}AppIdUserPool`];
    currentEnvSpecificValues[`${d.toLowerCase()}AppSecretUserPool`] = configuredProviders[`${d.toLowerCase()}AppSecretUserPool`];
  });
  return currentEnvSpecificValues;
}

function formatCredsforEnvParams(currentEnvSpecificValues, result, resourceParams) {
  const partialParams = {};
  if (currentEnvSpecificValues.hostedUIProviderCreds && result.hostedUIProviderCreds) {
    partialParams.hostedUIProviderCreds = [];
    const inputResult = JSON.parse(result.hostedUIProviderCreds);
    const previousResult = JSON.parse(currentEnvSpecificValues.hostedUIProviderCreds);
    if (resourceParams.hostedUIProviderMeta) {
      const currentProviders = JSON.parse(resourceParams.hostedUIProviderMeta)
        .map(h => h.ProviderName);
      currentProviders.forEach((c) => {
        const previousProvider = previousResult.find(p => p.ProviderName === c);
        const resultProvider = inputResult.find(r => r.ProviderName === c);
        partialParams.hostedUIProviderCreds.push(Object.assign(resultProvider, previousProvider));
      });
      partialParams.hostedUIProviderCreds = JSON.stringify(partialParams.hostedUIProviderCreds);
    }
  } else if (currentEnvSpecificValues.hostedUIProviderCreds && !result.hostedUIProviderCreds) {
    partialParams.hostedUIProviderCreds = currentEnvSpecificValues.hostedUIProviderCreds;
  } else if (!currentEnvSpecificValues.hostedUIProviderCreds && result.hostedUIProviderCreds) {
    partialParams.hostedUIProviderCreds = result.hostedUIProviderCreds;
  }
  return partialParams;
}

function parseCredsForHeadless(mergedValues, envParams) {
  const oAuthProviders = JSON.parse(mergedValues.hostedUIProviderMeta)
    .map(h => h.ProviderName);
  envParams.hostedUIProviderCreds = JSON.stringify(oAuthProviders
    .map(el => ({ ProviderName: el, client_id: mergedValues[`${el.toLowerCase()}AppIdUserPool`], client_secret: mergedValues[`${el.toLowerCase()}AppSecretUserPool`] })));
  oAuthProviders.forEach((i) => {
    delete envParams[`${i.toLowerCase()}AppIdUserPool`];
    delete envParams[`${i.toLowerCase()}AppSecretUserPool`];
  });
}

function getRequiredParamsForHeadlessInit(projectType, previousValues) {
  const requiredParams = [];

  if (previousValues.thirdPartyAuth) {
    if (previousValues.authProviders.includes('accounts.google.com')) {
      requiredParams.push('googleClientId');
      if (projectType === 'ios') {
        requiredParams.push('googleIos');
      }
      if (projectType === 'android') {
        requiredParams.push('googleAndroid');
      }
    }
    if (previousValues.authProviders.includes('graph.facebook.com')) {
      requiredParams.push('facebookAppId');
    }
    if (previousValues.authProviders.includes('www.amazon.com')) {
      requiredParams.push('amazonAppId');
    }
  }

  if (previousValues.hostedUIProviderMeta) {
    const oAuthProviders = JSON.parse(previousValues.hostedUIProviderMeta).map(h => h.ProviderName);
    if (oAuthProviders && oAuthProviders.length > 0) {
      oAuthProviders.forEach((o) => {
        requiredParams.push(`${o.toLowerCase()}AppIdUserPool`);
        requiredParams.push(`${o.toLowerCase()}AppSecretUserPool`);
      });
    }
  }
  return requiredParams;
}


async function console(context, amplifyMeta) {
  const cognitoOutput = getCognitoOutput(amplifyMeta);
  if (cognitoOutput) {
    const { Region } = amplifyMeta.providers.awscloudformation;
    if (cognitoOutput.UserPoolId && cognitoOutput.IdentityPoolId) {
      const answer = await inquirer.prompt({
        name: 'selection',
        type: 'list',
        message: 'Which console',
        choices: ['User Pool', 'Identity Pool', 'Both'],
        default: 'Both',
      });

      switch (answer.selection) {
        case 'User Pool':
          await openUserPoolConsole(context, Region, cognitoOutput.UserPoolId);
          break;
        case 'Identity Pool':
          await openIdentityPoolConsole(context, Region, cognitoOutput.IdentityPoolId);
          break;
        default:
          await openUserPoolConsole(context, Region, cognitoOutput.UserPoolId);
          await openIdentityPoolConsole(context, Region, cognitoOutput.IdentityPoolId);
          break;
      }
    } else if (cognitoOutput.UserPoolId) {
      await openUserPoolConsole(context, Region, cognitoOutput.UserPoolId);
    } else {
      await openIdentityPoolConsole(context, Region, cognitoOutput.IdentityPoolId);
    }
    context.print.info('');
  } else {
    context.print.error('Amazon Cognito resources have NOT been created for your project.');
  }
}

function getCognitoOutput(amplifyMeta) {
  let cognitoOutput;
  const categoryMeta = amplifyMeta.auth;
  const services = Object.keys(categoryMeta);
  for (let i = 0; i < services.length; i += 1) {
    const serviceMeta = categoryMeta[services[i]];
    if (serviceMeta.service === 'Cognito' &&
      serviceMeta.output &&
      (serviceMeta.output.UserPoolId || serviceMeta.output.IdentityPoolId)) {
      cognitoOutput = serviceMeta.output;
      break;
    }
  }
  return cognitoOutput;
}

async function openUserPoolConsole(context, region, userPoolId) {
  const userPoolConsoleUrl =
    `https://${region}.console.aws.amazon.com/cognito/users/?region=${region}#/pool/${userPoolId}/details`;
  await opn(userPoolConsoleUrl, { wait: false });
  context.print.info('User Pool console:');
  context.print.success(userPoolConsoleUrl);
}

async function openIdentityPoolConsole(context, region, identityPoolId) {
  const identityPoolConsoleUrl =
    `https://${region}.console.aws.amazon.com/cognito/pool/?region=${region}&id=${identityPoolId}`;
  await opn(identityPoolConsoleUrl, { wait: false });
  context.print.info('Identity Pool console:');
  context.print.success(identityPoolConsoleUrl);
}

function getPermissionPolicies(context, service, resourceName, crudOptions) {
  serviceMetadata = context.amplify.readJsonFile(`${__dirname}/../supported-services.json`)[service];
  const { serviceWalkthroughFilename } = serviceMetadata;
  const serviceWalkthroughSrc = `${__dirname}/service-walkthroughs/${serviceWalkthroughFilename}`;
  const { getIAMPolicies } = require(serviceWalkthroughSrc);

  if (!getPermissionPolicies) {
    context.print.info(`No policies found for ${resourceName}`);
    return;
  }

  return getIAMPolicies(resourceName, crudOptions);
}

async function lambdaTriggers(coreAnswers, context, previouslySaved, getAllDefaults) {
  const { handleTriggers } = require('./utils/trigger-flow-auth-helper');
  let triggerKeyValues = {};
  if (coreAnswers.authTriggers) {
    triggerKeyValues = await handleTriggers(context, coreAnswers, previouslySaved);
    coreAnswers.authTriggers = triggerKeyValues ?
      JSON.stringify(triggerKeyValues) :
      '{}';

    if (triggerKeyValues) {
      coreAnswers.parentStack = { Ref: 'AWS::StackId' };
      if (triggerKeyValues.DefineAuthChallenge) {
        if (triggerKeyValues.DefineAuthChallenge.includes('captcha') && (coreAnswers.mfaConfiguration === 'OFF' || !coreAnswers.mfaConfiguration)) {
          const defaults = getAllDefaults(coreAnswers.resourceName);
          coreAnswers.mfaConfiguration = 'ON';
          if (!coreAnswers.mfaTypes || coreAnswers.mfaTypes.length < 1) {
            coreAnswers.mfaTypes = defaults.mfaTypes;
          }
          if (!coreAnswers.smsAuthenticationMessage) {
            coreAnswers.mfaTypes = defaults.smsAuthenticationMessage;
          }
          if (!coreAnswers.smsVerificationMessage) {
            coreAnswers.mfaTypes = defaults.smsVerificationMessage;
          }
        }
      }
    }

    // determine permissions needed for each trigger module
    coreAnswers.permissions = await context.amplify.getTriggerPermissions(context, coreAnswers.authTriggers, 'amplify-category-auth', coreAnswers.resourceName);
  } else if (previouslySaved) {
    const targetDir = context.amplify.pathManager.getBackendDirPath();
    Object.keys(previouslySaved).forEach((p) => {
      delete coreAnswers[p];
    });
    await context.amplify
      .deleteAllTriggers(previouslySaved, coreAnswers.resourceName, targetDir, context);
  }
  // remove unused coreAnswers.authTriggers key
  if (coreAnswers.authTriggers && coreAnswers.authTriggers === '[]') {
    delete coreAnswers.authTriggers;
  }

  // handle dependsOn data
  const dependsOnKeys = Object.keys(triggerKeyValues).map(i => `${coreAnswers.resourceName}${i}`);
  coreAnswers.dependsOn = context.amplify.dependsOnBlock(context, dependsOnKeys, 'Cognito');
}


module.exports = {
  addResource,
  updateResource,
  updateConfigOnEnvInit,
  saveResourceParameters,
  ENV_SPECIFIC_PARAMS,
  copyCfnTemplate,
  migrate,
  console,
  getPermissionPolicies,
};
