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
