import { createStreamableValue } from '../streamable';
import { readStreamableValue } from './streamable';

function nextTick() {
  return Promise.resolve();
}

async function getRawChunks(s: any) {
  const { next, ...otherFields } = s;
  const chunks = [otherFields];
  if (next) {
    chunks.push(...(await getRawChunks(await next)));
  }
  return chunks;
}

describe('rsc - readStreamableValue()', () => {
  it('should return an async iterable', () => {
    const streamable = createStreamableValue();
    const result = readStreamableValue(streamable.value);
    streamable.done();

    expect(result).toBeDefined();
    expect(result[Symbol.asyncIterator]).toBeDefined();
  });

  it('should directly emit the final value when reading .value', async () => {
    const streamable = createStreamableValue('1');
    streamable.update('2');
    streamable.update('3');

    expect(streamable.value).toMatchInlineSnapshot(`
      {
        "curr": "3",
        "next": Promise {},
        "type": Symbol(ui.streamable.value),
      }
    `);

    streamable.done('4');

    expect(streamable.value).toMatchInlineSnapshot(`
      {
        "curr": "4",
        "type": Symbol(ui.streamable.value),
      }
    `);
  });

  it('should be able to stream any JSON values', async () => {
    const streamable = createStreamableValue();
    streamable.update({ v: 123 });

    expect(streamable.value).toMatchInlineSnapshot(`
      {
        "curr": {
          "v": 123,
        },
        "next": Promise {},
        "type": Symbol(ui.streamable.value),
      }
    `);

    streamable.done();
  });

  it('should support .error()', async () => {
    const streamable = createStreamableValue();
    streamable.error('This is an error');

    expect(streamable.value).toMatchInlineSnapshot(`
      {
        "error": "This is an error",
        "type": Symbol(ui.streamable.value),
      }
    `);
  });

  it('should support reading streamed values and errors', async () => {
    const streamable = createStreamableValue(1);
    (async () => {
      await nextTick();
      streamable.update(2);
      await nextTick();
      streamable.update(3);
      await nextTick();
      streamable.error('This is an error');
    })();

    const values = [];

    try {
      for await (const v of readStreamableValue(streamable.value)) {
        values.push(v);
      }
    } catch (e) {
      expect(e).toMatchInlineSnapshot(`"This is an error"`);
    }

    expect(values).toMatchInlineSnapshot(`
      [
        1,
        2,
        3,
      ]
    `);
  });

  it('should be able to read values asynchronously with different value types', async () => {
    const streamable = createStreamableValue({});

    (async () => {
      // Defer this a bit.
      await Promise.resolve();
      streamable.update([1]);
      streamable.update(['2']);
      streamable.done({ 3: 3 });
    })();

    const values = [];
    for await (const v of readStreamableValue(streamable.value)) {
      values.push(v);
    }
    expect(values).toMatchInlineSnapshot(`
      [
        {},
        [
          1,
        ],
        [
          "2",
        ],
        {
          "3": 3,
        },
      ]
    `);
  });

  it('should be able to replay errors', async () => {
    const streamable = createStreamableValue(0);

    (async () => {
      // Defer this a bit.
      await Promise.resolve();
      streamable.update(1);
      streamable.update(2);
      streamable.error({ customErrorMessage: 'this is an error' });
    })();

    const values = [];

    try {
      for await (const v of readStreamableValue(streamable.value)) {
        values.push(v);
      }
    } catch (e) {
      expect(e).toMatchInlineSnapshot(`
        {
          "customErrorMessage": "this is an error",
        }
      `);
    }
    expect(values).toMatchInlineSnapshot(`
      [
        0,
        1,
        2,
      ]
    `);
  });

  describe('patch', () => {
    it('should be able to append strings as patch', async () => {
      const streamable = createStreamableValue();
      const value = streamable.value;

      streamable.update('hello');
      streamable.update('hello world');
      streamable.update('hello world!');
      streamable.update('new string');
      streamable.done('new string with patch!');

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": undefined,
            "type": Symbol(ui.streamable.value),
          },
          {
            "curr": "hello",
          },
          {
            "diff": [
              0,
              " world",
            ],
          },
          {
            "diff": [
              0,
              "!",
            ],
          },
          {
            "curr": "new string",
          },
          {
            "diff": [
              0,
              " with patch!",
            ],
          },
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          "hello",
          "hello world",
          "hello world!",
          "new string",
          "new string with patch!",
        ]
      `);
    });

    it('should be able to call .append() to send patches', async () => {
      const streamable = createStreamableValue();
      const value = streamable.value;

      streamable.append('hello');
      streamable.append(' world');
      streamable.append('!');
      streamable.done();

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": undefined,
            "type": Symbol(ui.streamable.value),
          },
          {
            "curr": "hello",
          },
          {
            "diff": [
              0,
              " world",
            ],
          },
          {
            "diff": [
              0,
              "!",
            ],
          },
          {},
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          "hello",
          "hello world",
          "hello world!",
        ]
      `);
    });

    it('should be able to mix .update() and .append() with optimized payloads', async () => {
      const streamable = createStreamableValue('hello');
      const value = streamable.value;

      streamable.append(' world');
      streamable.update('hello world!!');
      streamable.update('some new');
      streamable.update('some new string');
      streamable.append(' with patch!');
      streamable.done();

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": "hello",
            "type": Symbol(ui.streamable.value),
          },
          {
            "diff": [
              0,
              " world",
            ],
          },
          {
            "diff": [
              0,
              "!!",
            ],
          },
          {
            "curr": "some new",
          },
          {
            "diff": [
              0,
              " string",
            ],
          },
          {
            "diff": [
              0,
              " with patch!",
            ],
          },
          {},
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          "hello",
          "hello world",
          "hello world!!",
          "some new",
          "some new string",
          "some new string with patch!",
        ]
      `);
    });

    it('should behave like .update() with .append() and .done()', async () => {
      const streamable = createStreamableValue('hello');
      const value = streamable.value;

      streamable.append(' world');
      streamable.done('fin');

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": "hello",
            "type": Symbol(ui.streamable.value),
          },
          {
            "diff": [
              0,
              " world",
            ],
          },
          {
            "curr": "fin",
          },
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          "hello",
          "hello world",
          "fin",
        ]
      `);
    });
  });

  describe('readableStream', () => {
    it('should be able to accept readableStream as the source', async () => {
      const streamable = createStreamableValue(
        new ReadableStream({
          start(controller) {
            controller.enqueue('hello');
            controller.enqueue(' world');
            controller.enqueue('!');
            controller.close();
          },
        }),
      );
      const value = streamable.value;

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": undefined,
            "type": Symbol(ui.streamable.value),
          },
          {
            "curr": "hello",
          },
          {
            "diff": [
              0,
              " world",
            ],
          },
          {
            "diff": [
              0,
              "!",
            ],
          },
          {},
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          "hello",
          "hello world",
          "hello world!",
        ]
      `);
    });

    it('should accept readableStream with JSON payloads', async () => {
      const streamable = createStreamableValue(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ v: 1 });
            controller.enqueue({ v: 2 });
            controller.enqueue({ v: 3 });
            controller.close();
          },
        }),
      );
      const value = streamable.value;

      expect(await getRawChunks(value)).toMatchInlineSnapshot(`
        [
          {
            "curr": undefined,
            "type": Symbol(ui.streamable.value),
          },
          {
            "curr": {
              "v": 1,
            },
          },
          {
            "curr": {
              "v": 2,
            },
          },
          {
            "curr": {
              "v": 3,
            },
          },
          {},
        ]
      `);

      const values = [];
      for await (const v of readStreamableValue(value)) {
        values.push(v);
      }
      expect(values).toMatchInlineSnapshot(`
        [
          {
            "v": 1,
          },
          {
            "v": 2,
          },
          {
            "v": 3,
          },
        ]
      `);
    });

    it('should lock the streamable if from readableStream', async () => {
      const streamable = createStreamableValue(
        new ReadableStream({
          async start(controller) {
            await nextTick();
            controller.enqueue('hello');
            controller.close();
          },
        }),
      );

      expect(() =>
        streamable.update('world'),
      ).toThrowErrorMatchingInlineSnapshot(
        '[Error: .update(): Value stream is locked and cannot be updated.]',
      );
    });
  });
});



/*
Awesome, let's do this!

First, here is the stream-ui.ui.test.tsx, which is colocated with the stream-ui implementation.

The two streamable.ui.test.tsx are located one next to streamable.tsx which defines createStreamableUI, etc., and the other is next to client/streamable.tsx, which defines readStreamableValue, and the various hooks like useActions, useAIState, useUIState, etc. 

I will share them one at a time, as they are 200-500 lines each; here is the stream-ui test:
*/