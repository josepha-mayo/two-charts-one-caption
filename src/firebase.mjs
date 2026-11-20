import {initializeApp, deleteApp} from 'firebase/app';
import {getToken, initializeAppCheck, ReCaptchaEnterpriseProvider} from 'firebase/app-check';
import {getAI, GoogleAIBackend, getGenerativeModel, InferenceMode, InferenceSource} from 'firebase/ai';

const deviceModels = new WeakMap();
let deviceClient;
let cloudModel;
let appCheck;
let config;
const debugToken = import.meta.env.DEV && location.hostname === '127.0.0.1'
  ? import.meta.env.VITE_CHARTS_APP_CHECK_DEBUG_TOKEN
  : '';

export async function configure() {
  const response = await fetch(import.meta.env.BASE_URL + 'firebase.local.json', {cache: 'no-store'});
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw Error('This preview has no Firebase configuration.');
  }
  config = await response.json();
  if (!config.firebase?.apiKey || !config.firebase?.projectId || !config.firebase?.appId ||
      (!config.appCheckSiteKey && !debugToken)) {
    throw Error('Firebase web configuration and an App Check site key are required.');
  }
}

export async function generateOnDevice(prompt, responseConstraint) {
  deviceClient ??= getAI(initializeApp(config.firebase, 'two-charts-device'), {backend: new GoogleAIBackend()});
  let model = deviceModels.get(responseConstraint);
  if (!model) {
    model = getGenerativeModel(deviceClient, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {promptOptions: {responseConstraint}},
    }, {timeout: 60_000});
    deviceModels.set(responseConstraint, model);
  }
  return generate(model, prompt, InferenceSource.ON_DEVICE);
}

export async function generateInCloud(prompt) {
  if (!cloudModel) {
    const app = initializeApp(config.firebase, 'two-charts-cloud');
    try {
      if (debugToken) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey ?? 'loopback-debug-only'),
        isTokenAutoRefreshEnabled: true,
      });
      const client = getAI(app, {backend: new GoogleAIBackend()});
      cloudModel = getGenerativeModel(client, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {model: 'gemini-3.5-flash-lite', generationConfig: {responseMimeType: 'application/json', maxOutputTokens: 2200}},
      }, {timeout: 60_000});
    } catch (error) {
      await deleteApp(app);
      throw error;
    }
  }
  try {
    await getToken(appCheck);
  } catch {
    throw Error('Firebase couldn’t verify this browser. Retry in Chrome or use the browser check.');
  }
  return generate(cloudModel, prompt, InferenceSource.IN_CLOUD);
}

async function generate(model, prompt, source) {
  let response;
  try {
    ({response} = await model.generateContent(prompt));
  } catch (error) {
    if (source === InferenceSource.ON_DEVICE) throw Error('On-device inference is unavailable in this Chrome session.');
    if (error?.status === 429 || error?.customData?.status === 429) {
      throw Error('Cloud Gemini has reached its request limit. Try again later or use the browser check.');
    }
    throw Error('Cloud Gemini couldn’t complete the request. Retry or use the browser check.');
  }
  if (response.inferenceSource !== source) {
    throw Error('Firebase returned an unexpected inference source.');
  }
  try {
    return JSON.parse(response.text());
  } catch {
    throw Error('The model returned an invalid draft. Try again or use the browser check.');
  }
}
