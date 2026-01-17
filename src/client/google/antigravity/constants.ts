export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  // 'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  // 'https://cloudcode-pa.googleapis.com',
] as const;

export const CODE_ASSIST_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/9.15.1',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

export const CODE_ASSIST_API_VERSION = 'v1internal';

export function isClaudeModel(modelId: string): boolean {
  return modelId.includes('claude');
}

export function isClaudeThinkingModel(modelId: string): boolean {
  return isClaudeModel(modelId) && modelId.includes('thinking');
}
