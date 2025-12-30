import { GoogleGenAI, type HttpOptions } from '@google/genai';
import * as path from 'node:path';
import * as os from 'node:os';
import { GoogleAIStudioProvider } from './ai-studio-client';
import { ModelConfig, ProviderConfig } from '../../types';
import { DEFAULT_TIMEOUT_CONFIG } from '../../utils';

/**
 * Vertex AI provider that extends Google AI Studio provider.
 *
 * Supports two authentication modes:
 *
 * 1. API Key mode (express mode):
 *    - Detected when apiKey is NOT a file path
 *    - Uses global endpoint: https://aiplatform.googleapis.com
 *    - No project/location needed
 *
 * 2. Service Account mode (standard mode):
 *    - Detected when apiKey IS a file path (e.g., /path/to/key.json)
 *    - Requires baseUrl with project and location:
 *      https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}
 */
export class VertexAIProvider extends GoogleAIStudioProvider {
  private readonly isServiceAccountAuth: boolean;
  private readonly serviceAccountPath: string | undefined;
  private readonly vertexProject: string | undefined;
  private readonly vertexLocation: string | undefined;
  private readonly vertexBaseDomain: string | undefined;

  constructor(config: ProviderConfig) {
    super(config);

    const detected = this.detectAuthMethod(config.apiKey);
    this.isServiceAccountAuth = detected.isServiceAccount;
    this.serviceAccountPath = detected.filePath;

    // Parse project and location from baseUrl
    // Expected format: https://{location}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{location}
    const parsed = this.parseVertexUrl(config.baseUrl);
    this.vertexProject = parsed.project;
    this.vertexLocation = parsed.location;
    this.vertexBaseDomain = parsed.baseDomain;
  }

  /**
   * Parse project, location, and base domain from Vertex AI URL.
   *
   * Expected format:
   * https://{location}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{location}
   */
  private parseVertexUrl(baseUrl: string): {
    project?: string;
    location?: string;
    baseDomain?: string;
  } {
    try {
      const url = new URL(baseUrl);
      // Match: /projects/{project}/locations/{location}
      const match = url.pathname.match(
        /\/projects\/([^/]+)\/locations\/([^/]+)/,
      );
      if (match) {
        return {
          project: match[1],
          location: match[2],
          baseDomain: url.origin,
        };
      }
    } catch {
      // Invalid URL
    }
    return {};
  }

  /**
   * Detects whether the apiKey is a file path (service account) or an API key.
   *
   * File path detection:
   * - Ends with .json
   * - Is an absolute path
   * - Starts with ~/ (home directory)
   * - Starts with ./ (relative path)
   * - File exists and is readable
   */
  private detectAuthMethod(apiKey: string | undefined): {
    isServiceAccount: boolean;
    filePath?: string;
  } {
    if (!apiKey) {
      return { isServiceAccount: false };
    }

    const trimmed = apiKey.trim();

    // Check if it looks like a file path
    if (
      trimmed.endsWith('.json') ||
      path.isAbsolute(trimmed) ||
      trimmed.startsWith('~/') ||
      trimmed.startsWith('./')
    ) {
      // Resolve the path
      let resolvedPath = trimmed;
      if (trimmed.startsWith('~/')) {
        resolvedPath = path.join(os.homedir(), trimmed.slice(2));
      }
      return { isServiceAccount: true, filePath: resolvedPath };
    }

    return { isServiceAccount: false };
  }

  protected override createClient(
    modelConfig: ModelConfig | undefined,
    streamEnabled: boolean,
  ): GoogleGenAI {
    const requestTimeoutMs = streamEnabled
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    // Use the base domain (without path) for httpOptions.baseUrl
    // The SDK will construct the full URL using project/location
    const httpOptions: HttpOptions = {
      baseUrl: this.vertexBaseDomain ?? this.baseUrl,
      headers: this.buildHeaders(modelConfig),
      timeout: requestTimeoutMs,
      extraBody: this.buildExtraBody(modelConfig),
    };

    if (this.isServiceAccountAuth && this.serviceAccountPath) {
      // Service account JSON key authentication (standard mode)
      return new GoogleGenAI({
        vertexai: true,
        project: this.vertexProject,
        location: this.vertexLocation,
        googleAuthOptions: {
          keyFilename: this.serviceAccountPath,
        },
        apiVersion: this.apiVersion,
        httpOptions,
      });
    } else {
      // Google Cloud API key authentication (express mode)
      return new GoogleGenAI({
        vertexai: true,
        apiKey: this.config.apiKey,
        apiVersion: this.apiVersion,
        httpOptions,
      });
    }
  }
}
