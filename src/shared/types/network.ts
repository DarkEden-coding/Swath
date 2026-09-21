/** Stable, opaque identifiers are generated once and never derived from hostnames or paths. */
export type NetworkId = string;
export type DeviceId = string;

export interface Network {
  id: NetworkId;
  name: string;
  schemaVersion: 2;
  revision: number;
  createdAt: number;
}

export interface Device {
  id: DeviceId;
  networkId: NetworkId;
  displayName: string;
  hostname: string;
  platform: string;
  enrollmentId: string;
  revision: number;
  tombstonedAt?: number;
}

export interface NetworkMember {
  deviceId: DeviceId;
  voter: boolean;
  healthy: boolean;
  endpoint?: string;
}

export interface NetworkHealth {
  networkId: NetworkId;
  voters: number;
  healthyVoters: number;
  required: number;
  quorum: boolean;
}

export interface NetworkDiscovery {
  name: string;
  url: string;
  online: boolean;
}

export interface CatalogSnapshot {
  network: Network;
  devices: Device[];
  members: NetworkMember[];
}

export type CatalogMutation = {
  kind: "renameNetwork";
  name: string;
};

export interface CatalogMutationRequest {
  networkId: NetworkId;
  operationId: string;
  expectedRevision: number;
  mutation: CatalogMutation;
}

export interface CatalogMutationResult {
  revision: number;
  result: CatalogSnapshot;
}
