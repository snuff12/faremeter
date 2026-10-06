#!/usr/bin/env pnpm tsx

import t from "tap";
import type { PaymentHandler } from "@faremeter/types/client";
import {
  computeBodyDigest,
  formatWWWAuthenticate,
  type MPPPaymentHandler,
} from "@faremeter/types/mpp";

import { wrap, type WrapOpts } from "./fetch";

const url = "https://example.com/protected";
const body = "original body";
const protocols = ["x402v1", "x402v2", "mpp"] as const;
type Protocol = (typeof protocols)[number];

function createPaymentOptions(protocol: Protocol): WrapOpts {
  const handler: PaymentHandler = async (_ctx, requirements) =>
    requirements.map((requirement) => ({
      requirements: requirement,
      exec: async () => ({ payload: { test: true } }),
    }));
  const mppHandler: MPPPaymentHandler = async (challenge) => ({
    challenge,
    exec: async () => ({ challenge, payload: { test: true } }),
  });
  return {
    handlers: [handler],
    ...(protocol === "mpp" ? { mppHandlers: [mppHandler] } : {}),
    retryCount: 1,
    initialRetryDelay: 0,
  };
}

function createPaymentResponse(protocol: Protocol, digest?: string) {
  if (protocol === "mpp") {
    return new Response(null, {
      status: 402,
      headers: {
        "WWW-Authenticate": formatWWWAuthenticate([
          {
            id: "test-id",
            realm: "test",
            method: "test-method",
            intent: "charge",
            request: "dGVzdA",
            ...(digest === undefined ? {} : { digest }),
          },
        ]),
      },
    });
  }

  const requirements = {
    scheme: "exact",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    amount: "1000",
    asset: "test-asset",
    payTo: "test-receiver",
    maxTimeoutSeconds: 60,
  };
  if (protocol === "x402v2") {
    return new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": btoa(
          JSON.stringify({
            x402Version: 2,
            resource: { url },
            accepts: [requirements],
          }),
        ),
      },
    });
  }

  return new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [
        {
          ...requirements,
          network: "solana-devnet",
          maxAmountRequired: requirements.amount,
          resource: url,
          description: "test resource",
          mimeType: "text/plain",
        },
      ],
    }),
    { status: 402 },
  );
}

for (const protocol of protocols) {
  const paymentHeader =
    protocol === "mpp"
      ? "Authorization"
      : protocol === "x402v2"
        ? "PAYMENT-SIGNATURE"
        : "X-PAYMENT";

  await t.test(
    `${protocol} preserves Request headers on paid retry`,
    async (t) => {
      let calls = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        t.equal(request.headers.get("X-Caller"), "keep-me");
        t.equal(request.headers.has(paymentHeader), calls > 0);
        calls++;
        return calls === 1
          ? createPaymentResponse(protocol)
          : new Response("ok");
      };
      const response = await wrap(
        fetch,
        createPaymentOptions(protocol),
      )(new Request(url, { headers: { "X-Caller": "keep-me" } }));
      t.equal(response.status, 200);
      t.equal(calls, 2);
      t.end();
    },
  );

  const headerOverrides: HeadersInit[] = [
    {},
    new Headers({ "X-Override": "new" }),
    [["X-Override", "new"]],
  ];
  for (const headers of headerOverrides) {
    await t.test(`${protocol} honors init.headers replacement`, async (t) => {
      let calls = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        t.notOk(request.headers.has("X-Caller"));
        t.equal(
          request.headers.get("X-Override"),
          new Headers(headers).get("X-Override"),
        );
        calls++;
        return calls === 1
          ? createPaymentResponse(protocol)
          : new Response("ok");
      };
      const response = await wrap(fetch, createPaymentOptions(protocol))(
        new Request(url, { headers: { "X-Caller": "old" } }),
        { headers },
      );
      t.equal(response.status, 200);
      t.equal(calls, 2);
      t.end();
    });
  }

  await t.test(
    `${protocol} replays POST Request across retry cycles`,
    async (t) => {
      let calls = 0;
      const controller = new AbortController();
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        t.equal(request.method, "POST");
        t.equal(request.headers.get("X-Caller"), "keep-me");
        t.equal(request.headers.has(paymentHeader), calls % 2 === 1);
        t.equal(request.credentials, "include");
        t.equal(request.redirect, "manual");
        t.equal(request.signal.aborted, false);
        t.equal(await request.text(), body);
        calls++;
        return calls < 4 ? createPaymentResponse(protocol) : new Response("ok");
      };
      const response = await wrap(
        fetch,
        createPaymentOptions(protocol),
      )(
        new Request(url, {
          method: "POST",
          headers: { "X-Caller": "keep-me" },
          body,
          credentials: "include",
          redirect: "manual",
          signal: controller.signal,
        }),
      );
      t.equal(response.status, 200);
      t.equal(calls, 4);
      t.end();
    },
  );

  await t.test(`${protocol} replays init.body override`, async (t) => {
    let calls = 0;
    const init = {
      method: "PUT",
      body: new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("override body"));
          stream.close();
        },
      }),
      duplex: "half",
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      t.equal(request.method, "PUT");
      t.equal(await request.text(), "override body");
      calls++;
      return calls === 1 ? createPaymentResponse(protocol) : new Response("ok");
    };
    const response = await wrap(fetch, createPaymentOptions(protocol))(
      new Request(url, { method: "POST", body }),
      init,
    );
    t.equal(response.status, 200);
    t.equal(calls, 2);
    t.end();
  });
}

await t.test("MPP matches the effective Request body digest", async (t) => {
  for (const override of [false, true]) {
    const expectedBody = override ? "override body" : body;
    const digest = await computeBodyDigest(
      new TextEncoder().encode(expectedBody).buffer,
    );
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      t.equal(await request.text(), expectedBody);
      calls++;
      return calls === 1
        ? createPaymentResponse("mpp", digest)
        : new Response("ok");
    };
    const response = await wrap(fetch, createPaymentOptions("mpp"))(
      new Request(url, { method: "POST", body }),
      override ? { body: expectedBody } : undefined,
    );
    t.equal(response.status, 200);
    t.equal(calls, 2);
  }
  t.end();
});

await t.test(
  "non-402 Request response passes through without payment",
  async (t) => {
    const expected = new Response("unavailable", { status: 503 });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      t.equal(await request.text(), body);
      return expected;
    };
    const response = await wrap(fetch, { handlers: [] })(
      new Request(url, { method: "POST", body }),
    );
    t.equal(response, expected);
    t.end();
  },
);

function createOpenBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelCount++;
    },
  });
  return {
    stream,
    getCancelCount: () => cancelCount,
    close() {
      if (cancelCount === 0) controller?.close();
    },
  };
}

function createStreamingRequest(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const init = {
    method: "POST",
    body: stream,
    duplex: "half",
    ...(signal ? { signal } : {}),
  };
  return new Request(url, init);
}

async function withDeadline<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("request did not complete")),
      1000,
    );
  });
  return await Promise.race([work, deadline]).finally(() =>
    clearTimeout(timer),
  );
}

for (const protocol of protocols) {
  await t.test(
    `${protocol} skips unnecessary digest reads on an open body`,
    async (t) => {
      const source = createOpenBody();
      let paidCalls = 0;
      const options = createPaymentOptions(protocol);
      options.mppHandlers = createPaymentOptions("mpp").mppHandlers ?? [];
      options.phase1Fetch = async () => createPaymentResponse(protocol);
      const paidFetch: typeof fetch = async (input) => {
        if (!(input instanceof Request) || !input.body) {
          throw new Error("expected Request body");
        }
        const reader = input.body.getReader();
        const chunk = await reader.read();
        t.equal(new TextDecoder().decode(chunk.value), body);
        await reader.cancel();
        paidCalls++;
        return new Response("ok");
      };
      const work = wrap(
        paidFetch,
        options,
      )(createStreamingRequest(source.stream));
      try {
        t.equal((await withDeadline(work)).status, 200);
        t.equal(paidCalls, 1);
        t.equal(source.getCancelCount(), 1, "source released when call ends");
      } finally {
        source.close();
        await withDeadline(work).catch(() => undefined);
      }
    },
  );
}

for (const open of [false, true]) {
  await t.test(
    `non-402 body cancellation completes (open=${open})`,
    async (t) => {
      const source = createOpenBody();
      const expected = new Response("ok");
      const transport: typeof fetch = async (input) => {
        if (!(input instanceof Request) || !input.body) {
          throw new Error("expected Request body");
        }
        await input.body.cancel();
        return expected;
      };
      const requestInit = {
        method: "POST",
        body: open ? source.stream : body,
        duplex: "half",
      };
      const work = wrap(transport, { handlers: [] })(
        new Request(url, requestInit),
      );
      try {
        t.equal(await withDeadline(work), expected);
        if (open) t.equal(source.getCancelCount(), 1);
      } finally {
        source.close();
        await withDeadline(work).catch(() => undefined);
      }
    },
  );
}

await t.test("transport failure releases the replay source", async (t) => {
  const source = createOpenBody();
  const failure = new Error("transport failed");
  const transport: typeof fetch = async () => {
    throw failure;
  };
  const work = wrap(transport, { handlers: [] })(
    createStreamingRequest(source.stream),
  );
  try {
    await t.rejects(withDeadline(work), failure);
    t.equal(source.getCancelCount(), 1);
  } finally {
    source.close();
  }
});

await t.test(
  "caller abort interrupts a required MPP digest read",
  async (t) => {
    let sourceController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let markReading: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    let cancelCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(new TextEncoder().encode(body));
      },
      pull() {
        markReading?.();
      },
      cancel() {
        cancelCount++;
      },
    });
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const digest = await computeBodyDigest(
      new TextEncoder().encode(body).buffer,
    );
    let paidCalls = 0;
    const options = createPaymentOptions("mpp");
    options.phase1Fetch = async () => createPaymentResponse("mpp", digest);
    const transport: typeof fetch = async () => {
      paidCalls++;
      return new Response("ok");
    };
    const work = wrap(
      transport,
      options,
    )(createStreamingRequest(stream, controller.signal));
    try {
      await withDeadline(reading);
      controller.abort(reason);
      await t.rejects(withDeadline(work), reason);
      t.equal(paidCalls, 0);
      t.equal(cancelCount, 1);
    } finally {
      if (cancelCount === 0) sourceController?.close();
      await withDeadline(work).catch(() => undefined);
    }
  },
);
