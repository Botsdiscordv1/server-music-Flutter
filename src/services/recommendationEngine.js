function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
  return match ? match[1] : null;
}

function getTrackId(track) {
  return track.videoId || extractVideoId(track.uri || track.track_url || "");
}

function getTrackArtist(track) {
  return (track.artist || track.author || track.track_author || "").toLowerCase().trim();
}

function scoreTrack(track, context) {
  let score = 0;
  const artist = getTrackArtist(track);
  const trackId = getTrackId(track);

  if (!artist || !track.title) return -10;

  context.topArtists.forEach((a, i) => {
    const artistName = a.name.toLowerCase();
    if (artist.includes(artistName) || artistName.includes(artist)) {
      score += Math.max(1, 10 - i * 0.5);
    }
  });

  context.topGenres.forEach(g => {
    if (track.genre) {
      if (track.genre.toLowerCase().includes(g.genre.toLowerCase())) {
        score += 3;
      }
    }
  });

  if (context.likedTracks.some(t => getTrackId(t) === trackId)) {
    score += 8;
  }

  if (context.recentTracks.some(t => getTrackId(t) === trackId)) {
    score -= 4;
  }

  context.followedArtists.forEach(fa => {
    const artistName = fa.name.toLowerCase();
    if (artist.includes(artistName) || artistName.includes(artist)) {
      score += 3;
    }
  });

  return score;
}

function rankTracks(tracks, context) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  return tracks
    .map(t => ({ track: t, score: scoreTrack(t, context) }))
    .sort((a, b) => b.score - a.score)
    .map(t => t.track);
}

function interleaveTracks(mainTracks, discoveryTracks, ratio = 0.7) {
  const result = [];
  const mainCount = Math.floor(ratio * (mainTracks.length + discoveryTracks.length));
  const mainCopy = [...mainTracks];
  const discoveryCopy = [...discoveryTracks];

  while (mainCopy.length > 0 || discoveryCopy.length > 0) {
    if (mainCopy.length > 0 && (discoveryCopy.length === 0 || result.length % Math.round(1 / (1 - ratio)) !== 0)) {
      result.push(mainCopy.shift());
    } else if (discoveryCopy.length > 0) {
      result.push(discoveryCopy.shift());
    } else {
      break;
    }
  }

  return result;
}

module.exports = {
  scoreTrack,
  rankTracks,
  interleaveTracks,
};
