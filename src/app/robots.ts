import type { MetadataRoute } from "next";

// The portal is private: nothing here should ever be indexed.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
