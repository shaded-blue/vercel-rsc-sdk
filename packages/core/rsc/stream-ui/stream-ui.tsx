import {
  InvalidToolArgumentsError,
  LanguageModelV1,
  NoSuchToolError,
} from '@ai-sdk/provider';
import { ReactNode } from 'react';
import { z } from 'zod';

import { safeParseJSON } from '@ai-sdk/provider-utils';
import { CallSettings } from '../../core/prompt/call-settings';
import { convertToLanguageModelPrompt } from '../../core/prompt/convert-to-language-model-prompt';
import { getValidatedPrompt } from '../../core/prompt/get-validated-prompt';
import { prepareCallSettings } from '../../core/prompt/prepare-call-settings';
import { prepareToolsAndToolChoice } from '../../core/prompt/prepare-tools-and-tool-choice';
import { Prompt } from '../../core/prompt/prompt';
import { CallWarning, CoreToolChoice, FinishReason } from '../../core/types';
import {
  CompletionTokenUsage,
  calculateCompletionTokenUsage,
} from '../../core/types/token-usage';
import { retryWithExponentialBackoff } from '../../core/util/retry-with-exponential-backoff';
import { createStreamableUI } from '../streamable';
import { createResolvablePromise } from '../utils';

type Streamable = ReactNode | Promise<ReactNode>;

type Renderer<T extends Array<any>> = (
  ...args: T
) =>
  | Streamable
  | Generator<Streamable, Streamable, void>
  | AsyncGenerator<Streamable, Streamable, void>;

type RenderTool<PARAMETERS extends z.ZodTypeAny = any> = {
  description?: string;
  parameters: PARAMETERS;
  generate?: Renderer<
    [
      z.infer<PARAMETERS>,
      {
        toolName: string;
        toolCallId: string;
      },
    ]
  >;
};

type RenderText = Renderer<
  [
    {
      /**
       * The full text content from the model so far.
       */
      content: string;
      /**
       * The new appended text content from the model since the last `text` call.
       */
      delta: string;
      /**
       * Whether the model is done generating text.
       * If `true`, the `content` will be the final output and this call will be the last.
       */
      done: boolean;
    },
  ]
>;

type RenderResult = {
  value: ReactNode;
} & Awaited<ReturnType<LanguageModelV1['doStream']>>;

const defaultTextRenderer: RenderText = ({ content }: { content: string }) =>
  content;

/**
 * `streamUI` is a helper function to create a streamable UI from LLMs.
 */
export async function streamUI<
  TOOLS extends { [name: string]: z.ZodTypeAny } = {},
>({
  model,
  tools,
  toolChoice,
  system,
  prompt,
  messages,
  maxRetries,
  abortSignal,
  headers,
  initial,
  text,
  onFinish,
  ...settings
}: CallSettings &
  Prompt & {
    /**
     * The language model to use.
     */
    model: LanguageModelV1;

    /**
     * The tools that the model can call. The model needs to support calling tools.
     */
    tools?: {
      [name in keyof TOOLS]: RenderTool<TOOLS[name]>;
    };

    /**
     * The tool choice strategy. Default: 'auto'.
     */
    toolChoice?: CoreToolChoice<TOOLS>;

    text?: RenderText;
    initial?: ReactNode;
    /**
     * Callback that is called when the LLM response and the final object validation are finished.
     */
    onFinish?: (event: {
      /**
       * The reason why the generation finished.
       */
      finishReason: FinishReason;
      /**
       * The token usage of the generated response.
       */
      usage: CompletionTokenUsage;
      /**
       * The final ui node that was generated.
       */
      value: ReactNode;
      /**
       * Warnings from the model provider (e.g. unsupported settings)
       */
      warnings?: CallWarning[];
      /**
       * Optional raw response data.
       */
      rawResponse?: {
        /**
         * Response headers.
         */
        headers?: Record<string, string>;
      };
    }) => Promise<void> | void;
  }): Promise<RenderResult> {
  // TODO: Remove these errors after the experimental phase.
  if (typeof model === 'string') {
    throw new Error(
      '`model` cannot be a string in `streamUI`. Use the actual model instance instead.',
    );
  }
  if ('functions' in settings) {
    throw new Error(
      '`functions` is not supported in `streamUI`, use `tools` instead.',
    );
  }
  if ('provider' in settings) {
    throw new Error(
      '`provider` is no longer needed in `streamUI`. Use `model` instead.',
    );
  }
  if (tools) {
    for (const [name, tool] of Object.entries(tools)) {
      if ('render' in tool) {
        throw new Error(
          'Tool definition in `streamUI` should not have `render` property. Use `generate` instead. Found in tool: ' +
          name,
        );
      }
    }
  }

  const ui = createStreamableUI(initial);

  // The default text renderer just returns the content as string.
  const textRender = text || defaultTextRenderer;

  let finished: Promise<void> | undefined;

  async function handleRender(
    args: [payload: any] | [payload: any, options: any],
    renderer: undefined | Renderer<any>,
    res: ReturnType<typeof createStreamableUI>,
    lastCall = false,
  ) {


    //  If no generator function passed, exit (what are we supposed to render..?)
    if (!renderer) return;


    //  I believe createResolvable gives them their promise chaining
    const resolvable = createResolvablePromise<void>();


    // Finished is defined right above handleRender.
    if (finished) {
      finished = finished.then(() => resolvable.promise);
    } else {
      finished = resolvable.promise;
    }


    //  And here we go.
    //  First, get result of our generator (which is yield/returning the componentry)
    //  That's the 'value' in all the conditionals. 
    const value = renderer(...args);


    // So, three routes based on shape of the generator it seems.  Not sure what each represents yet.


    // Value is Object
    // value has property 'then' === function
    if (
      value instanceof Promise ||
      (value &&
        typeof value === 'object' &&
        'then' in value &&
        typeof value.then === 'function')
    ) {
      console.log('@handleRender => PROMISE.')
      const node = await (value as Promise<React.ReactNode>);

      if (lastCall) {
        res.done(node);
      } else {
        res.update(node);
      }

      resolvable.resolve(void 0);





      // Value is object
      // value has asyncIterator symbol.
    } else if (
      value &&
      typeof value === 'object' &&
      Symbol.asyncIterator in value
    ) {
      console.log('@handleRender => ASYNC ITERATOR.')
      const it = value as AsyncGenerator<
        React.ReactNode,
        React.ReactNode,
        void
      >;
      while (true) {
        const { done, value } = await it.next();
        if (lastCall && done) {
          res.done(value);
        } else {
          res.update(value);
        }
        if (done) break;
      }
      resolvable.resolve(void 0);


      // Value is object
      // value has iterator symbol
    } else if (value && typeof value === 'object' && Symbol.iterator in value) {
      console.log('@handleRender => ITERATOR.')
      const it = value as Generator<React.ReactNode, React.ReactNode, void>;
      while (true) {
        const { done, value } = it.next();
        if (lastCall && done) {
          res.done(value);
        } else {
          res.update(value);
        }
        if (done) break;
      }
      resolvable.resolve(void 0);


      /// Fallback
    } else {
      console.log('@handleRender => FALLBACK.')
      if (lastCall) {
        res.done(value);
      } else {
        res.update(value);
      }
      resolvable.resolve(void 0);
    }
  }

  const retry = retryWithExponentialBackoff({ maxRetries });
  const validatedPrompt = getValidatedPrompt({ system, prompt, messages });
  const result = await retry(() =>
    model.doStream({
      mode: {
        type: 'regular',
        ...prepareToolsAndToolChoice({ tools, toolChoice }),
      },
      ...prepareCallSettings(settings),
      inputFormat: validatedPrompt.type,
      prompt: convertToLanguageModelPrompt(validatedPrompt),
      abortSignal,
      headers,
    }),
  );

  const [stream, forkedStream] = result.stream.tee();

  (async () => {
    try {
      // Consume the forked stream asynchonously.

      let content = '';
      let hasToolCall = false;

      const reader = forkedStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        switch (value.type) {
          case 'text-delta': {
            content += value.textDelta;
            handleRender(
              [{ content, done: false, delta: value.textDelta }],
              textRender,
              ui,
            );
            break;
          }

          case 'tool-call-delta': {
            hasToolCall = true;
            break;
          }

          case 'tool-call': {
            const toolName = value.toolName as keyof TOOLS & string;

            if (!tools) {
              throw new NoSuchToolError({ toolName: toolName });
            }

            const tool = tools[toolName];
            if (!tool) {
              throw new NoSuchToolError({
                toolName,
                availableTools: Object.keys(tools),
              });
            }

            hasToolCall = true;
            const parseResult = safeParseJSON({
              text: value.args,
              schema: tool.parameters,
            });

            if (parseResult.success === false) {
              throw new InvalidToolArgumentsError({
                toolName,
                toolArgs: value.args,
                cause: parseResult.error,
              });
            }

            handleRender(
              [
                parseResult.value,
                {
                  toolName,
                  toolCallId: value.toolCallId,
                },
              ],
              tool.generate,
              ui,
              true,
            );

            break;
          }

          case 'error': {
            throw value.error;
          }

          case 'finish': {
            onFinish?.({
              finishReason: value.finishReason,
              usage: calculateCompletionTokenUsage(value.usage),
              value: ui.value,
              warnings: result.warnings,
              rawResponse: result.rawResponse,
            });
          }
        }
      }

      if (hasToolCall) {
        await finished;
      } else {
        handleRender([{ content, done: true }], textRender, ui, true);
        await finished;
      }
    } catch (error) {
      // During the stream rendering, we don't want to throw the error to the
      // parent scope but only let the React's error boundary to catch it.
      ui.error(error);
    }
  })();

  return {
    ...result,
    stream,
    value: ui.value,
  };
}
