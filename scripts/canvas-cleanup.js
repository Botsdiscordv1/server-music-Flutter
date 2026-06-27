require("dotenv").config();

const canvasCatalogService = require("../src/services/canvasCatalogService");
const spotify = require("../src/services/spotify");

function firstArtistName(track) {
  return track.artists?.[0] || track.artist || track.primaryArtist || "";
}

async function cleanSpotifyRecords() {
  const records = canvasCatalogService.listRecords();
  const spotifyRecords = records.filter((item) => item.bucket === "spotify" && item.ids?.spotifyTrackId);

  let updated = 0;
  for (const record of spotifyRecords) {
    const trackUri = `spotify:track:${record.ids.spotifyTrackId}`;
    try {
      const track = await spotify.decorateSpotifyTrackUri(trackUri);
      if (!track) continue;

      const nextTitle = track.name || record.title;
      const nextArtist = firstArtistName(track) || record.artist;
      const nextAlbum = track.album || record.album;

      const nextRecord = canvasCatalogService.upsertRecord({
        ...record,
        ids: {
          ...record.ids,
          spotifyTrackId: track.id,
        },
        source: "spotify",
        sourceUrl: track.uri,
        title: nextTitle,
        artist: nextArtist,
        primaryArtist: nextArtist || record.primaryArtist || record.artist,
        album: nextAlbum,
        releaseName: track.album || record.releaseName || record.album,
        releaseType: track.album ? (record.releaseType || "Album") : record.releaseType,
        durationMs: track.durationMs || record.durationMs || 0,
        artworkUrl: track.artworkUrl || record.artworkUrl,
        thumbnailUrl: track.artworkUrl || record.thumbnailUrl,
        featuredArtists: (track.artists || []).slice(1),
        confidence: 10,
      });

      if (nextRecord?.canonicalId && nextRecord.canonicalId !== record.canonicalId) {
        canvasCatalogService.removeRecord(record.canonicalId);
      }
      updated += 1;
    } catch (err) {
      console.warn(`[CanvasCleanup] Skipped ${record.canonicalId}: ${err.message}`);
    }
  }

  console.log(`[CanvasCleanup] Updated ${updated} spotify record(s)`);
}

cleanSpotifyRecords().catch((err) => {
  console.error(`[CanvasCleanup] Failed: ${err.message}`);
  process.exitCode = 1;
});
