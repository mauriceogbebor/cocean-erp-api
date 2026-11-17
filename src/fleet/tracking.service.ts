import { timingSafeEqual } from "node:crypto";
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { FLEET_RULES, type TrackerPingsInput } from "@cocean/contracts";
import { inArray, sql } from "drizzle-orm";
import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import { vehiclePositions, vehicles } from "../db/schema.js";
import { DB, ENV } from "../common/tokens.js";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Positions from the tracker provider. Which provider is still an open
 * decision; this takes a generic batch, authenticated by a shared key.
 */
@Injectable()
export class TrackingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ingest(input: TrackerPingsInput, key: string | undefined) {
    if (!this.env.TRACKER_API_KEY)
      throw new ServiceUnavailableException("Tracker positions aren't enabled");
    if (!key || !same(key, this.env.TRACKER_API_KEY))
      throw new UnauthorizedException("Wrong tracker key");
    const ids = [...new Set(input.pings.map((p) => p.trackerId))];
    const known = await this.db
      .select({ id: vehicles.id, trackerId: vehicles.trackerId })
      .from(vehicles)
      .where(inArray(vehicles.trackerId, ids));
    const byTracker = new Map(known.map((k) => [k.trackerId!, k.id]));
    const now = Date.now();
    const rows = input.pings
      .filter(
        (p) =>
          byTracker.has(p.trackerId) &&
          Date.parse(p.recordedAt) <= now + 60_000,
      )
      .map((p) => ({
        vehicleId: byTracker.get(p.trackerId)!,
        lat: String(p.lat),
        lng: String(p.lng),
        speedKph: p.speedKph === undefined ? null : String(p.speedKph),
        recordedAt: new Date(p.recordedAt),
      }));
    if (rows.length) await this.db.insert(vehiclePositions).values(rows);
    return { accepted: rows.length, ignored: input.pings.length - rows.length };
  }

  /** Every tracked vehicle's last position, how old it is, and the loading it's on. */
  async board() {
    const rows = await this.db.execute<{
      vehicle_id: string;
      plate: string;
      lat: string | null;
      lng: string | null;
      speed_kph: string | null;
      recorded_at: string | null;
      lifting_id: string | null;
      lifting_number: string | null;
      driver_name: string | null;
    }>(sql`
      select v.id as vehicle_id, v.plate, p.lat, p.lng, p.speed_kph, p.recorded_at,
             l.id as lifting_id, l.number as lifting_number, l.driver_name
      from vehicles v
      left join lateral (
        select lat, lng, speed_kph, recorded_at from vehicle_positions
        where vehicle_id = v.id order by recorded_at desc limit 1
      ) p on true
      left join lateral (
        select id, number, driver_name from liftings
        where vehicle_id = v.id and status = 'in_transit' order by loaded_at desc limit 1
      ) l on true
      where v.status = 'active' and v.tracker_id is not null
      order by v.plate`);
    const now = Date.now();
    return rows.rows.map((r) => {
      const age = r.recorded_at
        ? Math.round((now - Date.parse(r.recorded_at)) / 60_000)
        : null;
      return {
        vehicleId: r.vehicle_id,
        plate: r.plate,
        position: r.lat
          ? {
              lat: Number(r.lat),
              lng: Number(r.lng),
              speedKph: r.speed_kph ? Number(r.speed_kph) : null,
              recordedAt: r.recorded_at,
            }
          : null,
        minutesSinceReport: age,
        stale: age === null || age > FLEET_RULES.trackerStaleMinutes,
        lifting: r.lifting_id
          ? {
              id: r.lifting_id,
              number: r.lifting_number,
              driverName: r.driver_name,
            }
          : null,
      };
    });
  }
}
