/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {
  /**
   * Augments tool result parts with error metadata.
   */
  export interface LanguageModelToolResultPart {
    /**
     * Whether there was an error calling the tool. The tool may still have partially succeeded.
     */
    readonly isError?: boolean;
  }
}
