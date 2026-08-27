import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // postgres.js opens real sockets; keep it out of the bundle so the serverless
  // function requires it at runtime instead of webpack tracing it badly.
  serverExternalPackages: ['postgres'],

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  /**
   * `src/` imports carry explicit `.js` extensions, which is what Node ESM and
   * tsx require and what keeps the same modules runnable under vitest, the
   * seed scripts and Next alike. Webpack resolves those literally and fails, so
   * it is told to try `.ts`/`.tsx` first.
   *
   * The alternative — dropping the extensions — would break every script that
   * runs outside the bundler. This is the smaller compromise.
   */
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default config;
