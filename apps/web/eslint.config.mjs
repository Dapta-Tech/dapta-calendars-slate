import base from '@slate/config/eslint';

export default [
  ...base,
  {
    /**
     * `lib/theme.ts` is read by three runtimes at once — the middleware (edge),
     * a client island, and the server layouts — and that is only true while it
     * stays pure. A `next/headers` import here does not fail here: it fails in
     * the middleware bundle and in the client component, with an error that
     * points at neither. The server-side readers live in `lib/theme.server.ts`,
     * which is where such an import belongs.
     *
     * The middleware is listed for the same reason from the other side: it runs
     * on the edge runtime, where `next/headers` does not exist at all.
     */
    files: ['lib/theme.ts', 'middleware.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/headers',
              message:
                'This module is imported by the edge middleware and by a client component. Server-only reads belong in lib/theme.server.ts.',
            },
          ],
        },
      ],
    },
  },
];
