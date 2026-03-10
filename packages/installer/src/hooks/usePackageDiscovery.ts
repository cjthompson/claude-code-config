import { useState, useEffect } from "react";
import { discoverPackages } from "../lib/discover.ts";
import type { PackageDescriptor } from "../lib/types.ts";

export function usePackageDiscovery(repoRoot: string) {
    const [packages, setPackages] = useState<PackageDescriptor[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        discoverPackages(repoRoot)
            .then((pkgs) => {
                setPackages(pkgs);
                setLoading(false);
            })
            .catch((err) => {
                setError((err as Error).message);
                setLoading(false);
            });
    }, [repoRoot]);

    return { packages, setPackages, loading, error };
}
