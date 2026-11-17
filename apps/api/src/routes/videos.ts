/**
 * GET /v1/videos/{id}: precheck-only preview for the input panel.
 * Added by the PRD's frontend section ("Backend dependency raised by this section").
 *
 * Always 200 once the ID is valid: the body says whether the video can be used, so the client
 * shows the preview or the mapped message before submit. VIDEO_TOO_LONG is not blocking here;
 * `requires_clip_range` tells the client to ask for one instead.
 */
import { apiError, isVideoId, MatchCutError, warning, type Limits } from "@match-cut/core";
import { checkVideo, type VideoLookup } from "@match-cut/providers";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface VideosRouteDeps {
  lookup: VideoLookup;
  region: string;
  limits: Limits;
  authenticate: (req: FastifyRequest) => Promise<void>;
}

export async function videosRoutes(app: FastifyInstance, deps: VideosRouteDeps) {
  app.get<{ Params: { id: string } }>(
    "/v1/videos/:id",
    { preHandler: deps.authenticate },
    async (req) => {
      const { id } = req.params;
      if (!isVideoId(id)) throw new MatchCutError("INVALID_URL");

      const r = await checkVideo(deps.lookup, id, { region: deps.region, limits: deps.limits });
      const v = r.video;
      return {
        id,
        precheck: r.ok && r.skipped ? "skipped" : "ok",
        video: v && {
          id: v.id,
          title: v.title,
          channel: v.channel,
          thumbnail_url: v.thumbnailUrl,
          duration_seconds: v.durationSeconds,
          embeddable: v.embeddable,
        },
        blocking_error: r.ok ? null : apiError(r.code),
        requires_clip_range: r.ok && v !== null && v.durationSeconds > deps.limits.maxVideoSeconds,
        warnings: r.ok ? r.warnings.map((w) => warning(w.code, w.vars)) : [],
      };
    },
  );
}
