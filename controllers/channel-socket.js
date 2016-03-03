﻿var Channel = require("../models/channel");
var youtubedl = require("youtube-dl");
var linkify = require("linkify-it")();
linkify.tlds(require("tlds")); 

function ChannelSocketController(io, config) {
  if(!(this instanceof ChannelSocketController)) return new ChannelSocketController(io, config);

  this.io = io;
  this.config = config;

  this.io.of("/channels").on("connection", Socket.bind(this));
}

function Socket(socket, io, config) {
  if(!(this instanceof Socket)) return new Socket(socket, this.io, this.config);

  this.io = io;
  this.config = config;
  this.socket = socket;
  this.socket.on("join", this.join.bind(this));
}

Socket.prototype = {
  join: function(id) {
    this.id = id;
    this.socket.on("getTime", this.getTime.bind(this));
    this.socket.on("pushTime", this.pushTime.bind(this));
    this.socket.on("ready", this.ready.bind(this));
    this.socket.on("play", this.play.bind(this));
    this.socket.on("pause", this.pause.bind(this));
    this.socket.on("seeked", this.seeked.bind(this));
    this.socket.on("addItems", this.addItems.bind(this));
    this.socket.on("loadPlaylist", this.loadPlaylist.bind(this));
    this.socket.on("removeItem", this.removeItem.bind(this));
    this.socket.on("moveItem", this.moveItem.bind(this));
    this.socket.on("refreshItem", this.refreshItem.bind(this));
    this.socket.on("playItem", this.playItem.bind(this));
    this.socket.on("chatMessage", this.chatMessage.bind(this));
    this.socket.on("updateUser", this.updateUser.bind(this));
    this.socket.on("moderatorUpdate", this.moderatorUpdate.bind(this));
    this.socket.on("disconnect", this.disconnect.bind(this));

    Channel.findOne({_id: this.id}, function(error, data) {
      if(error) throw error;
      if(!data) return;

      if(!data.private || this.socket.request.session.loggedInId == this.id) {

        this.socket.join(this.id);
        console.log(this.socket.client.id + " joined " + id);

        //assume first user who joins is channel creator
        var user = {socketId: this.socket.client.id, username: this.socket.request.session.username, moderator: data.users.length ? false : true};
        this.io.of("/channels").to(this.id).emit("connected", user);

        //remove expiration time of channel
        Channel.findOneAndUpdate({_id: this.id}, {$push: {users: user}, $set: {createdAt: null}}, {upsert: true, new: true}, function(error, data) {
          if(error) throw error;

          this.socket.emit("setup", data);

          if(data.users.length == 1) {
            var channel = data.toIndex();
            this.io.of("/index").emit("addChannel", channel);
            return;
          }
          this.io.of("/index").emit("incrementUsercount", this.id);

        }.bind(this));

      }
    }.bind(this));
  },

  getTime: function() {
    this.socket.to(this.id).emit("requestTime");
  },

  pushTime: function(data) {
    this.socket.to(this.id).emit("pushTime", data);
  },

  //if all users in a channel have loaded metadata of selected video, start playing it
  ready: function() {
    Channel.findOneAndUpdate({"users.socketId": this.socket.client.id}, {$set: {"users.$.ready": true}}, {new: true}, function(error, data) {
      if(error) throw error;

      var ready = 0;
      for(var i = 0; i < data.users.length; i++) {
        if(data.users[i].ready) {
          ready++;
        }
      }

      if(ready == data.users.length) {
        for(var i = 0; i < data.users.length; i++) {
          Channel.update({"users.socketId": data.users[i].socketId}, {$set: {"users.$.ready": false}}).exec();
        }
        this.io.of("/channels").to(this.id).emit("play", 0);
        Channel.update({_id: this.id}, {playing: true}).exec();
      }
    }.bind(this));
  },

  play: function(time) {
    this.isModerator(function() {
      Channel.update({_id: this.id}, {playing: true}).exec();
      this.socket.to(this.id).emit("play", time);
    }.bind(this));
  },

  pause: function(time) {
    this.isModerator(function() {
      Channel.update({_id: this.id}, {playing: false}).exec();
      this.socket.to(this.id).emit("pause", time);
    }.bind(this));
  },

  seeked: function(time) {
    this.isModerator(function() {
      this.socket.to(this.id).emit("seeked", time);
    }.bind(this));
  },

  getMedia: function(url, addPlaylist, callback) {
    var args = [];

    //route traffic to youtube through http proxy to circumvent IP blocks
    if(url.indexOf("youtube.com") > -1 && this.config.youtubedlProxy.host && this.config.youtubedlProxy.port) args = args.concat(["--proxy", this.config.youtubedlProxy.host + ":" + this.config.youtubedlProxy.port]);
    if(!addPlaylist) args = args.concat(["--playlist-end", "1"]);

    youtubedl.getInfo(url, args, {maxBuffer: 1024000 * 5}, function(error, media) {
      if(!error) {
        if(Object.prototype.toString.call(media) !== "[object Array]") {
          media = [media];
        }

        var files = [];
        
        for(var i = 0; i < media.length; i++) {
          var formats = [];
          if(media[i].formats) {
            for(var i2 = 0; i2 < media[i].formats.length; i2++) {
              if(media[i].formats[i2].format_note != "DASH video" && media[i].formats[i2].format_note != "DASH audio") {
                if((media[i].formats[i2].ext == "mp4" || media[i].formats[i2].ext == "webm")) {
                  formats.push({
                    type: "video/" + media[i].formats[i2].ext,
                    src: media[i].formats[i2].url,
                    res: media[i].formats[i2].height,
                    label: media[i].formats[i2].height + "p"
                  });
                }
                else if(media[i].formats[i2].ext == "mp3" || media[i].formats[i2].ext == "ogg") {
                  formats.push({
                    type: "audio/" + media[i].formats[i2].ext,
                    src: media[i].formats[i2].url,
                    label: "audio"
                  });
                }
              }
            }
          }
          else {
            formats.push({
              src: media[i].url,
              label: (media[i].height ? media[i].height + "p" : "unknown")
            });
          }
          formats.reverse();

          if(!formats.length) return callback(true);

          files.push({formats: formats, webpage: media[i].webpage_url, title: media[i].title});
        }
        return callback(false, files);
      }
      else {
        return callback(true);
      }
    });
  },

  addItems: function(data) {
    this.isModerator(function() {
      this.getMedia(data.url, data.addPlaylist, function(error, files) {
        if(error) {
          this.socket.emit("addItems", {error: error});
          return;
        }

        Channel.findOneAndUpdate({_id: this.id}, {$push: {playlist: {$each: files}}}, {upsert: true, new: true}, function(error, data) {
          if(error) throw error;

          for(var i = 0; i < files.length; i++) {
            files[i].id = data.playlist[data.playlist.length - files.length + i].id;
          }
          this.io.of("/channels").to(this.id).emit("addItems", files);
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  //if video url (potentially) expired fetch a new one from the webpage
  refreshItem: function(id) {
    Channel.findOne({_id: this.id}, function(error, data) {
      //only allow a single client to trigger a refresh
      if(this.socket.client.id === data.users[0].socketId) {
        Channel.findOne({"playlist._id": id}, {"playlist.$": 1}, function(error, data) {
          if(error) throw error;

          this.getMedia(data.playlist[0].webpage, false, function(error, files) {
            var data = {
              id: id,
              error: error,
              formats: files[0].formats
            };
            if(!error) Channel.findOneAndUpdate({"playlist._id": id}, {$set: {"playlist.$.formats": files[0].formats}}).exec();
            this.io.of("/channels").to(this.id).emit("refreshItem", data);
          }.bind(this));
        }.bind(this));
      }
    }.bind(this));
  },

  loadPlaylist: function(items) {
    this.isModerator(function() {
      Channel.findOneAndUpdate({_id: this.id}, {$set: {playlist: items}}, {upsert: true, new: true}, function(error, data) {
        if(error) throw error;

        this.io.of("/channels").to(this.id).emit("loadPlaylist", data.playlist);
      }.bind(this));
    }.bind(this));
  },

  removeItem: function(data) {
    this.isModerator(function() {
      Channel.update({_id: this.id}, {$pull: {playlist: {_id: data.id}}}).exec();
      this.socket.to(this.id).emit("removeItem", data.index);
    }.bind(this));
  },

  moveItem: function(data) {
    this.isModerator(function() {
      Channel.findOne({_id: this.id}, function(error, channelObject) {
        if(error) throw error;

        channelObject.playlist.splice(data.newIndex, 0, channelObject.playlist.splice(data.oldIndex, 1)[0]);
        Channel.update({_id: this.id}, {$set: {playlist: channelObject.playlist}}).exec();
      }.bind(this));
      this.socket.to(this.id).emit("moveItem", {oldIndex: data.oldIndex, newIndex: data.newIndex});
    }.bind(this));
  },

  playItem: function(index) {
    this.isModerator(function() {
      this.socket.to(this.id).emit("playItem", index);
    }.bind(this));
  },

  chatMessage: function(text) {
    var matches = linkify.match(text);
    this.io.of("/channels").to(this.id).emit("chatMessage", {username: this.socket.request.session.username, text: text, urls: matches});
  },

  updateUser: function(data) {
    data.socketId = this.socket.client.id;
    this.io.of("/channels").to(this.id).emit("updateUser", data);
  },

  moderatorUpdate: function(data) {
    this.isModerator(function() {
      Channel.findOneAndUpdate({"users.socketId": data.socketId}, {$set: {"users.$.moderator": data.moderator}}).exec();
      this.io.of("/channels").to(this.id).emit("moderatorUpdate", data);
    }.bind(this));
  },

  isModerator: function(callback) {
    Channel.findOne({_id: this.id}, function(error, data) {
      if(error) throw error;

      for(var i = 0; i < data.users.length; i++) {
        if(this.socket.client.id == data.users[i].socketId && data.users[i].moderator) {
          callback();
        }
      }
    }.bind(this));
  },

  disconnect: function() {
    this.socket.to(this.id).emit("disconnected", {socketId: this.socket.client.id, username: this.socket.request.session.username});
    Channel.update({_id: this.id}, {$pull: {users: {socketId: this.socket.client.id}}}, function(error, data) {
      if(error) throw error;
      if(!data) return;
      
      this.io.of("/index").emit("decrementUsercount", this.id);

      Channel.findOne({_id: this.id}, function(error, data) {
        if(error) throw error;
        if(!data) return;

        if(data.users.length == 0) {
          Channel.remove({_id: this.id}, function(error) {
            if(error) throw error;
            
            this.io.of("/index").emit("removeChannel", this.id);
          }.bind(this));
        }
        else {
          var noModerator = true;
          for(var i = 0; i < data.users.length; i++) {
            if(data.users[i].moderator) noModerator = false;
          }
          if(noModerator) {
            data = {socketId: data.users[0].socketId, moderator: true};
            Channel.findOneAndUpdate({"users.socketId": data.socketId}, {$set: {"users.$.moderator": data.moderator}}).exec();
            this.io.of("/channels").to(this.id).emit("moderatorUpdate", data);
          }
        }
      }.bind(this));
    }.bind(this));
    console.log(this.socket.client.id + " left " + this.id);
  }
};

Socket.prototype.constructor = Socket;

module.exports = ChannelSocketController;
