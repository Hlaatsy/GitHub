/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The WhatsApp and Paystack webhooks verify HMAC signatures over the exact
  // bytes that were sent, so nothing may re-encode those request bodies.
  experimental: { serverComponentsExternalPackages: [] },
};
export default nextConfig;
