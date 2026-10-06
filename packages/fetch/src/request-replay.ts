export function createRequestReplay(request: Request) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let ended = reader === undefined;
  let disposed = false;
  let pendingRead: Promise<void> | undefined;

  const cancelSource = () => {
    void reader?.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancelSource, { once: true });
  if (request.signal.aborted) cancelSource();

  function createBody() {
    let index = 0;
    let canceled = false;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            request.signal.throwIfAborted();
            if (!disposed && index === chunks.length && !ended && reader) {
              pendingRead ??= reader
                .read()
                .then(({ done, value }) => {
                  if (done) ended = true;
                  else if (!disposed) chunks.push(value.slice());
                })
                .finally(() => {
                  pendingRead = undefined;
                });
              await pendingRead;
            }
            if (canceled) return;
            request.signal.throwIfAborted();
            const chunk = chunks[index++];
            if (disposed || chunk === undefined) controller.close();
            else controller.enqueue(chunk.slice());
          } catch (error) {
            controller.error(error);
          }
        },
        // Keep the source available for a possible paid retry. Canceling an
        // attempt must not wait for an unread replay branch to be canceled.
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
  }

  return {
    createRequest() {
      request.signal.throwIfAborted();
      const init = reader ? { body: createBody(), duplex: "half" } : {};
      return new Request(request, init);
    },
    readBody: () => new Response(createBody()).arrayBuffer(),
    dispose() {
      disposed = true;
      chunks.length = 0;
      request.signal.removeEventListener("abort", cancelSource);
      cancelSource();
    },
  };
}
