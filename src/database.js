require("./dns-patch");
const mongoose = require("mongoose");
const userSchema = require("./models/User").schema;

let dbReady = false;
const queue = [];

function whenReady(fn) {
  if (dbReady) return fn();
  queue.push(fn);
}

const userStatsSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  tracksPlayed: { type: Number, default: 0 },
  totalListenTime: { type: Number, default: 0 },
  favoriteArtist: String,
  lastPlayed: Date,
}, { timestamps: true });
userStatsSchema.index({ totalListenTime: -1 });

const playlistSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  name: { type: String, required: true },
  tracks: { type: Array, default: [] },
}, { timestamps: true });

const historySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  trackTitle: String,
  trackAuthor: String,
  trackUrl: String,
  trackDuration: Number,
  playedAt: { type: Date, default: Date.now },
});

const likedSongSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  trackTitle: String,
  trackAuthor: String,
  trackAuthors: { type: [String], default: [] },
  albumName: String,
  albumArtist: String,
  albumBrowseId: String,
  albumUrl: String,
  trackUrl: String,
  trackDuration: Number,
  artworkUrl: String,
  isrc: String,
  explicit: { type: Boolean, default: false },
  genres: { type: [String], default: [] },
  source: { type: String, default: "ytmsearch" },
  contentType: { type: String, enum: ["AUDIO", "VIDEO"], default: "AUDIO" },
  likedAt: { type: Date, default: Date.now },
});
likedSongSchema.index({ userId: 1, trackUrl: 1 });
likedSongSchema.index({ userId: 1, isrc: 1 });
likedSongSchema.index({ userId: 1, trackAuthor: 1 });

const metadataPoolSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true },
  isrc: String,
  trackTitle: String,
  trackAuthor: String,
  trackAuthors: [String],
  albumName: String,
  artworkUrl: String,
  thumbnailUrl: String,
  ytVideoId: String,
  explicit: Boolean,
  genres: [String],
  featuredArtists: [String],
  confidence: { type: Number, default: 0 },
  lastVerified: { type: Date, default: Date.now },
  version: { type: Number, default: 1 },
}, { timestamps: true });
metadataPoolSchema.index({ fingerprint: 1 }, { unique: true });
metadataPoolSchema.index({ isrc: 1 });
metadataPoolSchema.index({ updatedAt: -1 });

const likedAlbumSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  albumId: { type: String, required: true },
  albumName: String,
  artistName: String,
  artworkUrl: String,
  albumUrl: String,
  likedAt: { type: Date, default: Date.now },
});
likedAlbumSchema.index({ userId: 1, albumId: 1 }, { unique: true });

const followedArtistSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  artistId: { type: String, required: true },
  artistName: String,
  imageUrl: String,
  browseId: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
  followedAt: { type: Date, default: Date.now },
});
followedArtistSchema.index({ userId: 1, artistId: 1 }, { unique: true });

const trackPlaySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  trackTitle: String,
  trackAuthor: String,
  trackUrl: String,
  playCount: { type: Number, default: 1 },
});
trackPlaySchema.index({ userId: 1, trackUrl: 1 }, { unique: true });

const dislikedSongSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  trackTitle: String,
  trackAuthor: String,
  trackUrl: String,
  trackKey: { type: String, required: true },
  dislikedAt: { type: Date, default: Date.now },
});
dislikedSongSchema.index({ userId: 1, trackKey: 1 }, { unique: true });

function cleanAuthor(author) {
  return (author || "").replace(/\s*-\s*Topic$/i, "").trim();
}

// ── Event Tracking ─────────────────────────────────────────────────────────
const eventSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  sessionId: { type: String, required: true },
  event: {
    type: String,
    enum: ["impression", "play", "skip", "dwell"],
    required: true,
  },
  sectionType: { type: String, required: true },
  reasonKey: String,
  itemId: String,
  dwellMs: Number,
  timestamp: { type: Date, default: Date.now },
});
eventSchema.index({ userId: 1, timestamp: -1 });
eventSchema.index({ reasonKey: 1, timestamp: -1 });
eventSchema.index({ sessionId: 1 });

const rulePerformanceSchema = new mongoose.Schema({
  reasonKey: { type: String, unique: true, required: true },
  totalImpressions: { type: Number, default: 0 },
  totalPlays: { type: Number, default: 0 },
  totalSkips: { type: Number, default: 0 },
  totalDwellMs: { type: Number, default: 0 },
  totalDwellEvents: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 },
  playRate: { type: Number, default: 0 },
  skipRate: { type: Number, default: 0 },
  avgDwellMs: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

// ── Android connection (default) ───────────────────────────────────────
const UserStats = mongoose.model("UserStats", userStatsSchema);
const Playlist = mongoose.model("Playlist", playlistSchema);
const History = mongoose.model("History", historySchema);
const LikedSong = mongoose.model("LikedSong", likedSongSchema);
const TrackPlay = mongoose.model("TrackPlay", trackPlaySchema);
const DislikedSong = mongoose.model("DislikedSong", dislikedSongSchema);
const LikedAlbum = mongoose.model("LikedAlbum", likedAlbumSchema);
const FollowedArtist = mongoose.model("FollowedArtist", followedArtistSchema);
const MetadataPool = mongoose.model("MetadataPool", metadataPoolSchema);
const Event = mongoose.model("Event", eventSchema);
const RulePerformance = mongoose.model("RulePerformance", rulePerformanceSchema);
// ── Discord connection (separate DB) ──────────────────────────────────
const discordUri = process.env.DISCORD_MONGODB_URI;
const discordConn = discordUri ? mongoose.createConnection(discordUri) : null;

let DiscordUser = null;
let DiscordUserStats = null;
let DiscordPlaylist = null;
let DiscordHistory = null;
let DiscordLikedSong = null;
let DiscordTrackPlay = null;
let DiscordDislikedSong = null;
let DiscordLikedAlbum = null;
let DiscordFollowedArtist = null;
let DiscordMetadataPool = null;
let DiscordEvent = null;
let DiscordRulePerformance = null;
if (discordConn) {
  DiscordUser = discordConn.model("User", userSchema);
  DiscordUserStats = discordConn.model("UserStats", userStatsSchema);
  DiscordPlaylist = discordConn.model("Playlist", playlistSchema);
  DiscordHistory = discordConn.model("History", historySchema);
  DiscordLikedSong = discordConn.model("LikedSong", likedSongSchema);
  DiscordTrackPlay = discordConn.model("TrackPlay", trackPlaySchema);
  DiscordDislikedSong = discordConn.model("DislikedSong", dislikedSongSchema);
  DiscordLikedAlbum = discordConn.model("LikedAlbum", likedAlbumSchema);
  DiscordFollowedArtist = discordConn.model("FollowedArtist", followedArtistSchema);
  DiscordMetadataPool = discordConn.model("MetadataPool", metadataPoolSchema);
  DiscordEvent = discordConn.model("Event", eventSchema);
  DiscordRulePerformance = discordConn.model("RulePerformance", rulePerformanceSchema);
}

function getModels(source) {
  if (source === "discord" && discordConn) {
    return {
      UserStats: DiscordUserStats,
      Playlist: DiscordPlaylist,
      History: DiscordHistory,
      LikedSong: DiscordLikedSong,
      TrackPlay: DiscordTrackPlay,
      DislikedSong: DiscordDislikedSong,
      LikedAlbum: DiscordLikedAlbum,
      FollowedArtist: DiscordFollowedArtist,
      MetadataPool: DiscordMetadataPool,
      Event: DiscordEvent,
      RulePerformance: DiscordRulePerformance,
    };
  }
  return {
    UserStats, Playlist, History, LikedSong, TrackPlay,
    DislikedSong, LikedAlbum, FollowedArtist, MetadataPool,
    Event, RulePerformance,
  };
}

// ── Init DB ─────────────────────────────────────────────────────────────
async function initDB() {
  const uri = process.env.ANDROID_MONGODB_URI || process.env.MONGODB_URI || "mongodb://localhost:27017/musicbot";
  console.log("Conectado Android DB");
  await mongoose.connect(uri);

  if (discordConn) {
    try {
      await discordConn.asPromise();
      console.log("Conectado Discord DB");
    } catch (err) {
      console.warn("Discord DB no disponible (no fatal):", err.message);
    }
  }

  dbReady = true;
  queue.forEach(fn => fn());
  queue.length = 0;
  console.log("MongoDB ready");
}

// ── User Stats ─────────────────────────────────────────────────────────
async function updateUserStats(userId, trackDuration, artist, source = "android") {
  const { UserStats } = getModels(source);
  await whenReady(() => {});
  return UserStats.findOneAndUpdate(
    { userId },
    {
      $inc: { tracksPlayed: 1, totalListenTime: trackDuration },
      $set: { favoriteArtist: cleanAuthor(artist), lastPlayed: new Date() },
    },
    { upsert: true }
  );
}

async function getUserStats(userId, source = "android") {
  const { UserStats } = getModels(source);
  await whenReady(() => {});
  const doc = await UserStats.findOne({ userId }).lean();
  if (!doc) return null;
  return {
    user_id: doc.userId,
    tracks_played: doc.tracksPlayed,
    total_listen_time: doc.totalListenTime,
    favorite_artist: doc.favoriteArtist,
    last_played: doc.lastPlayed,
  };
}

async function getTopListeners(limit = 10, source = "android") {
  const { UserStats } = getModels(source);
  await whenReady(() => {});
  const docs = await UserStats.find().sort({ totalListenTime: -1 }).limit(limit).lean();
  return docs.map(doc => ({
    user_id: doc.userId,
    tracks_played: doc.tracksPlayed,
    total_listen_time: doc.totalListenTime,
    favorite_artist: doc.favoriteArtist,
  }));
}

// ── Playlists ───────────────────────────────────────────────────────────
async function savePlaylist(userId, name, tracks, source = "android") {
  const { Playlist } = getModels(source);
  await whenReady(() => {});
  const doc = await Playlist.create({ userId, name, tracks });
  return doc._id.toString();
}

async function getPlaylist(index, userId, source = "android") {
  const { Playlist } = getModels(source);
  await whenReady(() => {});
  const docs = await Playlist.find({ userId }).sort({ createdAt: -1 }).lean();
  const doc = docs[index - 1];
  if (!doc) return null;
  return {
    id: (index).toString(),
    user_id: doc.userId,
    name: doc.name,
    tracks: JSON.stringify(doc.tracks),
    created_at: doc.createdAt,
  };
}

async function getUserPlaylists(userId, source = "android") {
  const { Playlist } = getModels(source);
  await whenReady(() => {});
  const docs = await Playlist.find({ userId }).sort({ createdAt: -1 }).lean();
  return docs.map(doc => ({
    id: doc._id.toString(),
    user_id: doc.userId,
    name: doc.name,
    tracks: JSON.stringify(doc.tracks),
    created_at: doc.createdAt,
  }));
}

async function deletePlaylist(index, userId, source = "android") {
  const { Playlist } = getModels(source);
  await whenReady(() => {});
  const docs = await Playlist.find({ userId }).sort({ createdAt: -1 }).lean();
  const target = docs[index - 1];
  if (!target) return { changes: 0 };
  const res = await Playlist.deleteOne({ _id: target._id });
  return { changes: res.deletedCount };
}

// ── History ──────────────────────────────────────────────────────────────
async function addToHistory(userId, track, source = "android") {
  const { History } = getModels(source);
  await whenReady(() => {});
  return History.create({
    userId,
    trackTitle: track.info.title,
    trackAuthor: cleanAuthor(track.info.author),
    trackUrl: track.info.uri,
    trackDuration: track.info.duration,
  });
}

async function getHistory(userId, limit = 50, source = "android") {
  const { History } = getModels(source);
  await whenReady(() => {});
  const docs = await History.find({ userId }).sort({ playedAt: -1 }).limit(limit).lean();
  return docs.map(doc => ({
    id: doc._id.toString(),
    user_id: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_url: doc.trackUrl,
    track_duration: doc.trackDuration,
    played_at: doc.playedAt,
  }));
}

async function clearHistory(userId, source = "android") {
  const { History } = getModels(source);
  await whenReady(() => {});
  const res = await History.deleteMany({ userId });
  return { changes: res.deletedCount };
}

// ── Liked Songs ─────────────────────────────────────────────────────────
function extractIsrc(track) {
  if (!track?.info) return null;
  if (track.pluginInfo?.isrc) return track.pluginInfo.isrc;
  if (track.info.isrc) return track.info.isrc;
  if (track.info.extra?.isrc) return track.info.extra.isrc;
  if (track.info.identifier && /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/.test(track.info.identifier)) {
    return track.info.identifier;
  }
  return null;
}

async function addLikedSong(userId, track, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  try {
    const exists = await LikedSong.findOne({ userId, trackUrl: track.info.uri });
    if (exists) return false;
    const isrc = extractIsrc(track);
    const explicit = track.info.explicit === true || track.pluginInfo?.explicit === true;
    const genres = track.info.genres || track.pluginInfo?.genres || [];
    const sourceName = track.info.sourceName || "ytmsearch";
    const contentType = sourceName === "youtube_video" ? "VIDEO" : "AUDIO";
    const trackAuthors = track.pluginInfo?.trackAuthors || track.info?.authors || [];
    const albumName = track.info.album || track.info.albumName || track.pluginInfo?.album || track.pluginInfo?.albumName || null;
    const albumArtist = track.info.albumArtist || track.pluginInfo?.albumArtist || null;
    const albumBrowseId = track.info.albumBrowseId || track.pluginInfo?.albumBrowseId || null;
    const albumUrl = track.info.albumUrl || track.pluginInfo?.albumUrl || null;
    await LikedSong.create({
      userId,
      trackTitle: track.info.title,
      trackAuthor: cleanAuthor(track.info.author),
      trackAuthors: trackAuthors.length ? trackAuthors : undefined,
      albumName: albumName || undefined,
      albumArtist: cleanAuthor(albumArtist) || undefined,
      albumBrowseId: albumBrowseId || undefined,
      albumUrl: albumUrl || undefined,
      trackUrl: track.info.uri,
      trackDuration: track.info.duration,
      artworkUrl: track.info.artworkUrl,
      isrc: isrc || undefined,
      explicit: explicit || undefined,
      genres: genres.length ? genres : undefined,
      source: sourceName,
      contentType,
    });
    return true;
  } catch { return false; }
}

async function removeLikedSong(userId, id, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const songs = await LikedSong.find({ userId }).sort({ likedAt: -1 }).lean();
  const target = songs[id - 1];
  if (!target) return null;
  await LikedSong.deleteOne({ _id: target._id });
  return target;
}

async function removeLikedSongByTrack(userId, track, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const url = track?.info?.uri;
  if (url) {
    const deleted = await LikedSong.deleteOne({ userId, trackUrl: url });
    return deleted.deletedCount > 0;
  }
  const isrc = extractIsrc(track);
  if (isrc) {
    const deleted = await LikedSong.deleteOne({ userId, isrc });
    if (deleted.deletedCount > 0) return true;
  }
  const title = track?.info?.title;
  const author = track?.info?.author ? cleanAuthor(track.info.author) : "";
  if (title && author) {
    const deleted = await LikedSong.deleteOne({ userId, trackTitle: title, trackAuthor: author });
    if (deleted.deletedCount > 0) return true;
  }
  return false;
}

async function removeAllLikedSongs(userId, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const result = await LikedSong.deleteMany({ userId });
  return result.deletedCount;
}

async function getLikedSongs(userId, limit = 0, source = "android", contentType = null) {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  let filter = { userId };
  if (contentType === "AUDIO") {
    filter.$or = [{ contentType: "AUDIO" }, { contentType: { $exists: false } }];
  } else if (contentType === "VIDEO") {
    filter.contentType = "VIDEO";
  }
  let query = LikedSong.find(filter).sort({ likedAt: -1 });
  if (limit > 0) query = query.limit(limit);
  const docs = await query.lean();
  return docs.map(doc => ({
    id: doc._id.toString(),
    user_id: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_authors: doc.trackAuthors || [],
    album: doc.albumName || null,
    album_name: doc.albumName || null,
    album_artist: doc.albumArtist || null,
    albumBrowseId: doc.albumBrowseId || null,
    album_browse_id: doc.albumBrowseId || null,
    albumUrl: doc.albumUrl || null,
    album_url: doc.albumUrl || null,
    track_url: doc.trackUrl,
    track_duration: doc.trackDuration,
    artwork_url: doc.artworkUrl,
    isrc: doc.isrc,
    explicit: doc.explicit || false,
    genres: doc.genres || [],
    source: doc.source || "ytmsearch",
    content_type: doc.contentType || "AUDIO",
    liked_at: doc.likedAt,
  }));
}

async function isSongLiked(userId, track, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  if (!track?.info) return false;
  const url = track.info.uri;
  if (url) {
    const found = await LikedSong.findOne({ userId, trackUrl: url }).lean();
    if (found) return true;
  }
  const isrc = extractIsrc(track);
  if (isrc) {
    const found = await LikedSong.findOne({ userId, isrc }).lean();
    if (found) return true;
  }
  const title = (track.info.title || "").toLowerCase();
  const author = cleanAuthor(track.info.author || "").toLowerCase().trim();
  if (title && author) {
    const found = await LikedSong.findOne({
      userId,
      trackTitle: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      trackAuthor: { $regex: `^${author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    }).lean();
    if (found) return true;
  }
  return false;
}

function isSongInLikes(likedSongs, track) {
  if (!track?.info || !likedSongs || likedSongs.length === 0) return false;

  const currentUrl = track.info.uri;
  if (currentUrl && likedSongs.some(s => s.track_url === currentUrl)) {
    return true;
  }

  const currentIsrc = extractIsrc(track);
  if (currentIsrc) {
    const isrcMatch = likedSongs.some(s => s.isrc && s.isrc === currentIsrc);
    if (isrcMatch) return true;
  }

  const currentTitle = (track.info.title || "").toLowerCase();
  const currentAuthor = (track.info.author || "").replace(/\s*-\s*topic$/i, "").toLowerCase().trim();

  if (currentTitle && currentAuthor) {
    for (const song of likedSongs) {
      const likedTitle = (song.track_title || "").toLowerCase();
      const likedAuthor = (song.track_author || "").toLowerCase().trim();
      if (currentTitle === likedTitle && currentAuthor === likedAuthor) {
        return true;
      }
    }
  }

  return false;
}

async function getLikedArtists(userId, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const docs = await LikedSong.find({ userId, trackAuthor: { $ne: null } }).lean();
  const counts = {};
  for (const doc of docs) {
    const artist = doc.trackAuthor;
    if (artist) counts[artist] = (counts[artist] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Liked Albums ─────────────────────────────────────────────────────
async function toggleLikeAlbum(userId, album, source = "android") {
  const { LikedAlbum } = getModels(source);
  await whenReady(() => {});
  const existing = await LikedAlbum.findOne({ userId, albumId: album.albumId });
  if (existing) {
    await LikedAlbum.deleteOne({ _id: existing._id });
    return { liked: false };
  }
  await LikedAlbum.create({
    userId,
    albumId: album.albumId,
    albumName: album.albumName,
    artistName: album.artistName,
    artworkUrl: album.artworkUrl,
    albumUrl: album.albumUrl,
  });
  return { liked: true };
}

async function getLikedAlbums(userId, source = "android") {
  const { LikedAlbum } = getModels(source);
  await whenReady(() => {});
  const docs = await LikedAlbum.find({ userId }).sort({ likedAt: -1 }).lean();
  return docs.map(doc => ({
    id: doc._id.toString(),
    albumId: doc.albumId,
    albumName: doc.albumName,
    artistName: doc.artistName,
    artworkUrl: doc.artworkUrl,
    albumUrl: doc.albumUrl,
    likedAt: doc.likedAt,
  }));
}

async function isAlbumLiked(userId, albumId, source = "android") {
  const { LikedAlbum } = getModels(source);
  await whenReady(() => {});
  const found = await LikedAlbum.findOne({ userId, albumId }).lean();
  return !!found;
}

// ── Followed Artists ─────────────────────────────────────────────────
async function toggleFollowArtist(userId, artist, source = "android") {
  const { FollowedArtist } = getModels(source);
  await whenReady(() => {});
  const existing = await FollowedArtist.findOne({ userId, artistId: artist.artistId });
  if (existing) {
    await FollowedArtist.deleteOne({ _id: existing._id });
    return { followed: false };
  }
  await FollowedArtist.create({
    userId,
    artistId: artist.artistId,
    artistName: artist.artistName,
    imageUrl: artist.imageUrl,
    browseId: artist.browseId || null,
    updatedAt: new Date(),
  });
  return { followed: true };
}

async function setFollowedArtistCanonicalId(userId, artistId, canonicalArtistId, source = "android") {
  const { FollowedArtist } = getModels(source);
  await whenReady(() => {});

  if (!artistId || !canonicalArtistId || artistId === canonicalArtistId) return null;

  const current = await FollowedArtist.findOne({ userId, artistId });
  if (!current) return null;

  const existingCanonical = await FollowedArtist.findOne({ userId, artistId: canonicalArtistId });
  if (existingCanonical) {
    let changed = false;
    if (!existingCanonical.artistName && current.artistName) {
      existingCanonical.artistName = current.artistName;
      changed = true;
    }
    if (!existingCanonical.imageUrl && current.imageUrl) {
      existingCanonical.imageUrl = current.imageUrl;
      changed = true;
    }
    if (changed) await existingCanonical.save();
    await FollowedArtist.deleteOne({ _id: current._id });
    return existingCanonical.toObject();
  }

  current.artistId = canonicalArtistId;
  await current.save();
  return current.toObject();
}

async function getFollowedArtists(userId, source = "android") {
  const { FollowedArtist } = getModels(source);
  await whenReady(() => {});
  const docs = await FollowedArtist.find({ userId }).sort({ followedAt: -1 }).lean();
  return docs.map(doc => ({
    id: doc.artistId,
    artistId: doc.artistId,
    artistName: doc.artistName,
    imageUrl: doc.imageUrl,
    browseId: doc.browseId || null,
    updatedAt: doc.updatedAt,
    followedAt: doc.followedAt,
  }));
}

async function isArtistFollowed(userId, artistId, source = "android") {
  const { FollowedArtist } = getModels(source);
  await whenReady(() => {});
  const found = await FollowedArtist.findOne({ userId, artistId }).lean();
  return !!found;
}

async function incrementTrackPlay(userId, trackTitle, trackAuthor, trackUrl, source = "android") {
  const { TrackPlay } = getModels(source);
  await whenReady(() => {});
  return TrackPlay.findOneAndUpdate(
    { userId, trackUrl },
    { $inc: { playCount: 1 }, $set: { trackTitle, trackAuthor: cleanAuthor(trackAuthor) } },
    { upsert: true }
  );
}

async function getMostPlayedTracks(userId, limit = 10, source = "android") {
  const { TrackPlay } = getModels(source);
  await whenReady(() => {});
  const docs = await TrackPlay.find({ userId }).sort({ playCount: -1 }).limit(limit).lean();
  return docs.map(doc => ({
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_url: doc.trackUrl,
    play_count: doc.playCount,
  }));
}

async function copyLikedSongs(fromUserId, toUserId, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const sourceSongs = await LikedSong.find({ userId: fromUserId }).lean();
  if (sourceSongs.length === 0) return { copied: 0, skipped: 0, total: 0 };

  const existing = await LikedSong.find({ userId: toUserId }).lean();
  const existingUrls = new Set(existing.map(s => s.trackUrl).filter(Boolean));

  const toInsert = sourceSongs.filter(song => !existingUrls.has(song.trackUrl));
  if (toInsert.length > 0) {
    const docs = toInsert.map(song => ({
      userId: toUserId,
      trackTitle: song.trackTitle,
      trackAuthor: song.trackAuthor,
      trackUrl: song.trackUrl,
      trackDuration: song.trackDuration,
      artworkUrl: song.artworkUrl,
      isrc: song.isrc,
      explicit: song.explicit || undefined,
      genres: song.genres || undefined,
      source: song.source || "ytmsearch",
      contentType: song.contentType || "AUDIO",
    }));
    await LikedSong.insertMany(docs, { ordered: false });
  }

  return { copied: toInsert.length, skipped: sourceSongs.length - toInsert.length, total: sourceSongs.length };
}

async function copyPlaylist(fromUserId, toUserId, playlistName, source = "android") {
  const { Playlist } = getModels(source);
  await whenReady(() => {});
  const playlist = await Playlist.findOne({ userId: fromUserId, name: playlistName }).lean();
  if (!playlist) return null;

  let targetName = playlist.name;
  const exists = await Playlist.findOne({ userId: toUserId, name: targetName });
  if (exists) {
    targetName = `${playlist.name} (Copy)`;
  }

  await Playlist.create({
    userId: toUserId,
    name: targetName,
    tracks: playlist.tracks,
  });

  return { name: targetName, trackCount: playlist.tracks.length };
}

// ── Disliked Songs ──────────────────────────────────────────────────────
async function addDislikedSong(userId, track, source = "android") {
  const { DislikedSong } = getModels(source);
  await whenReady(() => {});
  const title = track.info?.title || track.track_title || "";
  const author = track.info?.author || track.track_author || "";
  const url = track.info?.uri || track.track_url || "";
  const key = `${cleanAuthor(author)} - ${title}`.trim();
  try {
    await DislikedSong.create({ userId, trackTitle: title, trackAuthor: author, trackUrl: url, trackKey: key });
    return true;
  } catch {
    return false;
  }
}

async function getDislikedKeys(userId, source = "android") {
  const { DislikedSong } = getModels(source);
  await whenReady(() => {});
  const docs = await DislikedSong.find({ userId }).lean();
  return new Set(docs.map(d => d.trackKey));
}

async function getDislikedSongs(userId, source = "android") {
  const { DislikedSong } = getModels(source);
  await whenReady(() => {});
  return DislikedSong.find({ userId }).sort({ dislikedAt: -1 }).lean();
}

async function removeDislikedSong(userId, trackKey, source = "android") {
  const { DislikedSong } = getModels(source);
  await whenReady(() => {});
  await DislikedSong.deleteOne({ userId, trackKey });
}

async function removeDislikedSongById(userId, id, source = "android") {
  const { DislikedSong } = getModels(source);
  await whenReady(() => {});
  const songs = await DislikedSong.find({ userId }).sort({ dislikedAt: -1 }).lean();
  const target = songs[id - 1];
  if (!target) return null;
  await DislikedSong.deleteOne({ _id: target._id });
  return target;
}

// ── Migration helpers ──────────────────────────────────────────────────
// ── Metadata Pool CRUD ──────────────────────────────────────────────────────

function createFingerprint(artist, title) {
  const a = (artist || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const t = (title || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  return `${a} - ${t}`.replace(/\s+/g, " ");
}

async function upsertMetadataPool(entry, source = "android") {
  const { MetadataPool } = getModels(source);
  await whenReady(() => {});
  const filter = entry.fingerprint ? { fingerprint: entry.fingerprint } : {};
  if (!entry.fingerprint) return null;
  const existing = await MetadataPool.findOne(filter).lean();
  if (existing) {
    const merged = { ...existing, ...entry, version: existing.version + 1, lastVerified: new Date() };
    await MetadataPool.updateOne(filter, { $set: merged });
    return { ...merged, _id: existing._id };
  }
  const doc = await MetadataPool.create({ ...entry, version: 1, lastVerified: new Date() });
  return doc.toObject();
}

async function getMetadataPool(fingerprint, source = "android") {
  const { MetadataPool } = getModels(source);
  await whenReady(() => {});
  if (!fingerprint) return null;
  return MetadataPool.findOne({ fingerprint }).lean();
}

async function getMetadataPoolByISRC(isrc, source = "android") {
  const { MetadataPool } = getModels(source);
  await whenReady(() => {});
  if (!isrc) return null;
  return MetadataPool.findOne({ isrc }).lean();
}

async function queryMetadataPool(filter = {}, limit = 50, source = "android") {
  const { MetadataPool } = getModels(source);
  await whenReady(() => {});
  return MetadataPool.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
}

async function getMetadataPoolChangesSince(since, source = "android") {
  const { MetadataPool } = getModels(source);
  await whenReady(() => {});
  return MetadataPool.find({ updatedAt: { $gte: new Date(since) } }).sort({ updatedAt: -1 }).lean();
}

async function updateLikedSongMetadata(userId, trackUrl, updates, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const setFields = {};
  if (updates.trackTitle) setFields.trackTitle = updates.trackTitle;
  if (updates.trackAuthor) setFields.trackAuthor = updates.trackAuthor;
  if (updates.trackAuthors) setFields.trackAuthors = updates.trackAuthors;
  if (updates.albumName) setFields.albumName = updates.albumName;
  if (updates.albumArtist) setFields.albumArtist = updates.albumArtist;
  if (updates.albumBrowseId) setFields.albumBrowseId = updates.albumBrowseId;
  if (updates.albumUrl) setFields.albumUrl = updates.albumUrl;
  if (updates.artworkUrl) setFields.artworkUrl = updates.artworkUrl;
  if (updates.explicit !== undefined) setFields.explicit = updates.explicit;
  if (updates.genres) setFields.genres = updates.genres;
  if (Object.keys(setFields).length === 0) return false;
  await LikedSong.updateOne({ userId, trackUrl }, { $set: setFields });
  return true;
}

const BAD_URI_REGEX = /^(https?:\/\/(www\.)?(deezer\.com|open\.spotify\.com)|spotify:(track|album|playlist):)/i;

async function findLikedSongByUrl(url, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const doc = await LikedSong.findOne({ trackUrl: url }).lean();
  if (!doc) return null;
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_authors: doc.trackAuthors || [],
    track_url: doc.trackUrl,
    isrc: doc.isrc,
  };
}

async function findLikedSongById(id, source = "android") {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const doc = await LikedSong.findById(id).lean().catch(() => null);
  if (!doc) return null;
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_authors: doc.trackAuthors || [],
    track_url: doc.trackUrl,
    isrc: doc.isrc,
  };
}

async function updateLikedSongUrl(docId, newUrl, source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const result = await LikedSong.updateOne({ _id: docId }, { $set: { trackUrl: newUrl } });
  return result.modifiedCount > 0;
}

async function getAllLikedSongsWithBadUrls(source = "android") {
  const { LikedSong } = getModels(source);
  await whenReady(() => {});
  const docs = await LikedSong.find({}).lean();
  return docs
    .filter(doc => doc.trackUrl && BAD_URI_REGEX.test(doc.trackUrl))
    .map(doc => ({
      _id: doc._id.toString(),
      userId: doc.userId,
      track_title: doc.trackTitle,
      track_author: doc.trackAuthor,
      track_authors: doc.trackAuthors || [],
      track_url: doc.trackUrl,
      isrc: doc.isrc,
    }));
}

// ── Recent Playback ──────────────────────────────────────────────────────────
const recentPlaybackSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  trackTitle: String,
  trackAuthor: String,
  trackUrl: String,
  trackDuration: Number,
  artworkUrl: String,
  playedAt: { type: Date, default: Date.now },
});
recentPlaybackSchema.index({ playedAt: -1 });

const recentPlaybackModels = new Map();

function getRecentPlaybackModel(userId, source = "android") {
  const key = `${source}:${userId}`;
  if (recentPlaybackModels.has(key)) return recentPlaybackModels.get(key);

  const collectionName = `recent_playback_${userId}`;
  const conn = source === "discord" && discordConn ? discordConn : mongoose.connection;
  const model = conn.model(collectionName, recentPlaybackSchema, collectionName);
  recentPlaybackModels.set(key, model);
  return model;
}

async function addRecentPlayback(userId, track, source = "android") {
  const Model = getRecentPlaybackModel(userId, source);
  await whenReady(() => {});
  return Model.create({
    userId,
    trackTitle: track.info?.title || track.trackTitle,
    trackAuthor: cleanAuthor(track.info?.author || track.trackAuthor || ""),
    trackUrl: track.info?.uri || track.trackUrl,
    trackDuration: track.info?.duration || track.trackDuration,
    artworkUrl: track.info?.artworkUrl || track.artworkUrl,
  });
}

async function getRecentPlayback(userId, limit = 50, source = "android") {
  const Model = getRecentPlaybackModel(userId, source);
  await whenReady(() => {});
  const docs = await Model.find({ userId }).sort({ playedAt: -1 }).limit(limit).lean();
  return docs.map(doc => ({
    id: doc._id.toString(),
    user_id: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_url: doc.trackUrl,
    track_duration: doc.trackDuration,
    artwork_url: doc.artworkUrl,
    played_at: doc.playedAt,
  }));
}

async function clearRecentPlayback(userId, source = "android") {
  const Model = getRecentPlaybackModel(userId, source);
  await whenReady(() => {});
  const res = await Model.deleteMany({ userId });
  return { changes: res.deletedCount };
}

// ── Sync ──────────────────────────────────────────────────────────────────────
async function syncUserData(userId, localData, source = "android") {
  const { LikedSong, Playlist, DislikedSong, FollowedArtist, LikedAlbum, TrackPlay } = getModels(source);
  await whenReady(() => {});
  const result = {};

  // 1. Liked Songs
  if (Array.isArray(localData.likedSongs)) {
    const cloudDocs = await LikedSong.find({ userId }).lean();
    const cloudUrls = new Set(cloudDocs.map(s => s.trackUrl).filter(Boolean));
    let added = 0;
    for (const song of localData.likedSongs) {
      if (song.trackUrl && cloudUrls.has(song.trackUrl)) continue;
      try {
        const incomingTrackAuthors = song.trackAuthors || song.track_authors || [];
        await LikedSong.create({
          userId,
          trackTitle: song.trackTitle || song.track_title || "",
          trackAuthor: cleanAuthor(song.trackAuthor || song.track_author || ""),
          trackAuthors: incomingTrackAuthors.length ? incomingTrackAuthors : undefined,
          albumName: song.album || song.album_name || undefined,
          albumArtist: song.albumArtist || song.album_artist || undefined,
          albumBrowseId: song.albumBrowseId || song.album_browse_id || undefined,
          albumUrl: song.albumUrl || song.album_url || undefined,
          trackUrl: song.trackUrl || song.track_url || "",
          trackDuration: song.trackDuration || song.track_duration || 0,
          artworkUrl: song.artworkUrl || song.artwork_url || "",
          isrc: song.isrc || undefined,
          explicit: song.explicit || false,
          genres: song.genres || [],
          source: song.source || "ytmsearch",
          contentType: song.contentType || "AUDIO",
        });
        added++;
      } catch {}
    }
    const all = await LikedSong.find({ userId }).sort({ likedAt: -1 }).lean();
    result.likedSongs = all.map(s => ({
        id: s._id.toString(),
        track_title: s.trackTitle,
        track_author: s.trackAuthor,
        track_authors: s.trackAuthors || [],
        album: s.albumName || null,
        album_name: s.albumName || null,
        album_artist: s.albumArtist || null,
        albumBrowseId: s.albumBrowseId || null,
        album_browse_id: s.albumBrowseId || null,
        albumUrl: s.albumUrl || null,
        album_url: s.albumUrl || null,
        track_url: s.trackUrl,
        track_duration: s.trackDuration,
        artwork_url: s.artworkUrl,
      isrc: s.isrc,
      explicit: s.explicit || false,
      genres: s.genres || [],
      source: s.source || "ytmsearch",
      content_type: s.contentType || "AUDIO",
      liked_at: s.likedAt,
    }));
    result.likedSongsAdded = added;
  }

  // 2. Recent Playback
  if (Array.isArray(localData.recentPlayback)) {
    const Model = getRecentPlaybackModel(userId, source);
    let added = 0;
    for (const item of localData.recentPlayback) {
      const title = item.trackTitle || item.track_title || "";
      if (!title) continue;
      try {
        await Model.create({
          userId,
          trackTitle: title,
          trackAuthor: cleanAuthor(item.trackAuthor || item.track_author || ""),
          trackUrl: item.trackUrl || item.track_url || "",
          trackDuration: item.trackDuration || item.track_duration || 0,
          artworkUrl: item.artworkUrl || item.artwork_url || "",
          playedAt: item.playedAt || item.played_at || new Date(),
        });
        added++;
      } catch {}
    }
    const all = await Model.find({ userId }).sort({ playedAt: -1 }).limit(200).lean();
    result.recentPlayback = all.map(d => ({
      id: d._id.toString(),
      track_title: d.trackTitle,
      track_author: d.trackAuthor,
      track_url: d.trackUrl,
      track_duration: d.trackDuration,
      artwork_url: d.artworkUrl,
      played_at: d.playedAt,
    }));
    result.recentPlaybackAdded = added;
  }

  // 3. Playlists
  if (Array.isArray(localData.playlists)) {
    const cloudDocs = await Playlist.find({ userId }).lean();
    const cloudNames = new Set(cloudDocs.map(p => p.name));
    let added = 0;
    for (const pl of localData.playlists) {
      const name = pl.name || "";
      if (!name || cloudNames.has(name)) continue;
      try {
        await Playlist.create({ userId, name, tracks: pl.tracks || [] });
        added++;
      } catch {}
    }
    const all = await Playlist.find({ userId }).sort({ createdAt: -1 }).lean();
    result.playlists = all.map(p => ({
      id: p._id.toString(),
      name: p.name,
      tracks: p.tracks,
      created_at: p.createdAt,
    }));
    result.playlistsAdded = added;
  }

  // 4. Disliked Songs
  if (Array.isArray(localData.dislikedSongs)) {
    const cloudDocs = await DislikedSong.find({ userId }).lean();
    const cloudKeys = new Set(cloudDocs.map(d => d.trackKey));
    let added = 0;
    for (const d of localData.dislikedSongs) {
      const title = d.trackTitle || d.track_title || "";
      const author = d.trackAuthor || d.track_author || "";
      const key = `${cleanAuthor(author)} - ${title}`.trim();
      if (!key || cloudKeys.has(key)) continue;
      try {
        await DislikedSong.create({
          userId,
          trackTitle: title,
          trackAuthor: author,
          trackUrl: d.trackUrl || d.track_url || "",
          trackKey: key,
        });
        added++;
      } catch {}
    }
    const all = await DislikedSong.find({ userId }).sort({ dislikedAt: -1 }).lean();
    result.dislikedSongs = all.map(d => ({
      id: d._id.toString(),
      track_title: d.trackTitle,
      track_author: d.trackAuthor,
      track_url: d.trackUrl,
      track_key: d.trackKey,
      disliked_at: d.dislikedAt,
    }));
    result.dislikedSongsAdded = added;
  }

  // 5. Followed Artists
  if (Array.isArray(localData.followedArtists)) {
    const cloudDocs = await FollowedArtist.find({ userId }).lean();
    const cloudIds = new Set(cloudDocs.map(a => a.artistId));
    let added = 0;
    for (const a of localData.followedArtists) {
      if (!a.artistId || cloudIds.has(a.artistId)) continue;
      try {
        await FollowedArtist.create({
          userId,
          artistId: a.artistId,
          artistName: a.artistName || a.artist_name || "",
          imageUrl: a.imageUrl || a.image_url || "",
          browseId: a.browseId || null,
        });
        added++;
      } catch {}
    }
    const all = await FollowedArtist.find({ userId }).sort({ followedAt: -1 }).lean();
    result.followedArtists = all.map(a => ({
      id: a.artistId,
      artistId: a.artistId,
      artist_name: a.artistName,
      image_url: a.imageUrl,
      browse_id: a.browseId || null,
      followed_at: a.followedAt,
    }));
    result.followedArtistsAdded = added;
  }

  // 6. Liked Albums
  if (Array.isArray(localData.likedAlbums)) {
    const cloudDocs = await LikedAlbum.find({ userId }).lean();
    const cloudIds = new Set(cloudDocs.map(a => a.albumId));
    let added = 0;
    for (const a of localData.likedAlbums) {
      if (!a.albumId || cloudIds.has(a.albumId)) continue;
      try {
        await LikedAlbum.create({
          userId,
          albumId: a.albumId,
          albumName: a.albumName || a.album_name || "",
          artistName: a.artistName || a.artist_name || "",
          artworkUrl: a.artworkUrl || a.artwork_url || "",
          albumUrl: a.albumUrl || a.album_url || "",
        });
        added++;
      } catch {}
    }
    const all = await LikedAlbum.find({ userId }).sort({ likedAt: -1 }).lean();
    result.likedAlbums = all.map(a => ({
      id: a._id.toString(),
      albumId: a.albumId,
      album_name: a.albumName,
      artist_name: a.artistName,
      artwork_url: a.artworkUrl,
      album_url: a.albumUrl,
      liked_at: a.likedAt,
    }));
    result.likedAlbumsAdded = added;
  }

  // 7. Stats (accumulate)
  if (localData.stats) {
    const s = localData.stats;
    const inc = {};
    if (s.tracksPlayed || s.tracks_played) inc.tracksPlayed = s.tracksPlayed || s.tracks_played;
    if (s.totalListenTime || s.total_listen_time) inc.totalListenTime = s.totalListenTime || s.total_listen_time;
    if (Object.keys(inc).length) {
      const update = { $inc: inc };
      if (s.favoriteArtist || s.favorite_artist) update.$set = { favoriteArtist: cleanAuthor(s.favoriteArtist || s.favorite_artist) };
      if (s.lastPlayed || s.last_played) update.$set = { ...(update.$set || {}), lastPlayed: s.lastPlayed || s.last_played };
      await UserStats.findOneAndUpdate({ userId }, update, { upsert: true });
    }
    const statsDoc = await UserStats.findOne({ userId }).lean();
    result.stats = statsDoc ? {
      tracks_played: statsDoc.tracksPlayed,
      total_listen_time: statsDoc.totalListenTime,
      favorite_artist: statsDoc.favoriteArtist,
      last_played: statsDoc.lastPlayed,
    } : null;
  }

  return result;
}

async function syncHistory(userId, historyEntries, source = "android") {
  const { History } = getModels(source);
  await whenReady(() => {});

  if (!Array.isArray(historyEntries)) {
    return [];
  }

  const docsToInsert = [];
  for (const entry of historyEntries) {
    const title = entry.trackTitle || entry.track_title;
    if (!title) continue;

    docsToInsert.push({
      userId,
      trackTitle: title,
      trackAuthor: cleanAuthor(entry.trackAuthor || entry.track_author || ""),
      trackUrl: entry.trackUrl || entry.track_url || "",
      trackDuration: entry.trackDuration || entry.track_duration || 0,
      playedAt: new Date(),
    });
  }

  if (docsToInsert.length === 0) return [];

  const createdDocs = await History.insertMany(docsToInsert);
  return createdDocs.map(doc => ({
    id: doc._id.toString(),
    user_id: doc.userId,
    track_title: doc.trackTitle,
    track_author: doc.trackAuthor,
    track_url: doc.trackUrl,
    track_duration: doc.trackDuration,
    played_at: doc.playedAt,
  }));
}

// ── Event Tracking CRUD ─────────────────────────────────────────────────────
async function recordEvent(eventData) {
  const { Event } = getModels(eventData.source || "android");
  await whenReady(() => {});
  try {
    await Event.create({
      userId: eventData.userId,
      sessionId: eventData.sessionId,
      event: eventData.event,
      sectionType: eventData.sectionType,
      reasonKey: eventData.reasonKey || null,
      itemId: eventData.itemId || null,
      dwellMs: eventData.dwellMs || 0,
    });
    return true;
  } catch (err) {
    console.warn("[DB] recordEvent error:", err.message);
    return false;
  }
}

async function getEvents(filter, limit = 1000) {
  const { Event } = getModels(filter.source || "android");
  await whenReady(() => {});
  const query = {};
  if (filter.userId) query.userId = filter.userId;
  if (filter.reasonKey) query.reasonKey = filter.reasonKey;
  if (filter.event) query.event = filter.event;
  if (filter.since) query.timestamp = { $gte: new Date(filter.since) };
  return Event.find(query).sort({ timestamp: -1 }).limit(limit).lean();
}

function getRulePerformanceModel(source) {
  return getModels(source).RulePerformance;
}

async function upsertRulePerformance(reasonKey, metrics) {
  const RulePerformance = getRulePerformanceModel();
  await whenReady(() => {});
  const setFields = {
    ...metrics,
    updatedAt: new Date(),
  };
  return RulePerformance.findOneAndUpdate(
    { reasonKey },
    { $set: setFields },
    { upsert: true, new: true }
  );
}

async function getRulePerformance(reasonKey) {
  const RulePerformance = getRulePerformanceModel();
  await whenReady(() => {});
  if (reasonKey) {
    return RulePerformance.findOne({ reasonKey }).lean();
  }
  return RulePerformance.find().sort({ ctr: -1 }).lean();
}

async function getEventAggregates(since) {
  const Event = getModels().Event;
  await whenReady(() => {});
  const match = since ? { timestamp: { $gte: new Date(since) } } : {};
  return Event.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$reasonKey",
        impressions: { $sum: { $cond: [{ $eq: ["$event", "impression"] }, 1, 0] } },
        plays: { $sum: { $cond: [{ $eq: ["$event", "play"] }, 1, 0] } },
        skips: { $sum: { $cond: [{ $eq: ["$event", "skip"] }, 1, 0] } },
        totalDwellMs: { $sum: { $cond: [{ $eq: ["$event", "dwell"] }, "$dwellMs", 0] } },
        dwellEvents: { $sum: { $cond: [{ $eq: ["$event", "dwell"] }, 1, 0] } },
      },
    },
  ]);
}

module.exports = {
  initDB,
  updateUserStats,
  getUserStats,
  getTopListeners,
  savePlaylist,
  getPlaylist,
  getUserPlaylists,
  deletePlaylist,
  addToHistory,
  getHistory,
  clearHistory,
  syncHistory,
  addLikedSong,
  removeLikedSong,
  removeLikedSongByTrack,
  removeAllLikedSongs,
  getLikedSongs,
  isSongLiked,
  isSongInLikes,
  extractIsrc,
  getLikedArtists,
  toggleLikeAlbum,
  getLikedAlbums,
  isAlbumLiked,
  toggleFollowArtist,
  setFollowedArtistCanonicalId,
  getFollowedArtists,
  isArtistFollowed,
  incrementTrackPlay,
  getMostPlayedTracks,
  copyLikedSongs,
  copyPlaylist,
  addDislikedSong,
  getDislikedKeys,
  getDislikedSongs,
  removeDislikedSong,
  removeDislikedSongById,
  findLikedSongByUrl,
  findLikedSongById,
  updateLikedSongUrl,
  getAllLikedSongsWithBadUrls,
  BAD_URI_REGEX,
  createFingerprint,
  upsertMetadataPool,
  getMetadataPool,
  getMetadataPoolByISRC,
  queryMetadataPool,
  getMetadataPoolChangesSince,
  updateLikedSongMetadata,
  DiscordUser,
  addRecentPlayback,
  getRecentPlayback,
  clearRecentPlayback,
  syncUserData,
  recordEvent,
  getEvents,
  upsertRulePerformance,
  getRulePerformance,
  getEventAggregates,
};
