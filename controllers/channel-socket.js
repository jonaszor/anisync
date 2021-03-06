﻿// This file is part of anisync.
// Copyright (C) 2020 Jannes Grzebien
// 
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
// 
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";
var Channel = require("../models/channel");
var YoutubeDL = require("../util/YoutubeDL");
var linkify = require("linkify-it")();
linkify.tlds(require("tlds")); 

function ChannelSocketController(io, config) {
    if(!(this instanceof ChannelSocketController)) return new ChannelSocketController(io, config);

    io.of("/channel").on("connection", (socket) => new Socket(io, socket, config));
}

class Socket {
    constructor(io, socket, config) {
        this.io = io;
        this.socket = socket;
        this.config = config;

        this.socket.on("join", (id) => {
            this.id = id;
            this.socket.on("getTime", () => this.getTime());
            this.socket.on("pushTime", (data) => this.pushTime(data));
            this.socket.on("ended", () => this.ended());
            this.socket.on("ready", () => this.ready());
            this.socket.on("play", (time) => this.play(time));
            this.socket.on("pause", (time) => this.pause(time));
            this.socket.on("seeked", (time) => this.seeked(time));
            this.socket.on("addMedia", (data) => this.addMedia(data));
            this.socket.on("removeItem", (data) => this.removeItem(data));
            this.socket.on("moveItem", (data) => this.moveItem(data));
            this.socket.on("refreshItem", (id) => this.refreshItem(id));
            this.socket.on("playItem", (index) => this.playItem(index));
            this.socket.on("loadPlaylist", (items) => this.loadPlaylist(items)); 
            this.socket.on("chatMessage", (text) => this.chatMessage(text));
            this.socket.on("updateUser", (data) => this.updateUser(data));
            this.socket.on("moderatorUpdate", (data) => this.moderatorUpdate(data));
            this.socket.on("kickban", (data) => this.kickban(data));
            this.socket.on("editChannelName", (newName) => this.editChannelName(newName));
            this.socket.on("setRepeat", (bool) => this.setRepeat(bool));
            this.socket.on("shufflePlaylist", (playlist) => this.shufflePlaylist(playlist));
            this.socket.on("disconnect", () => this.disconnect());
            this.join(id);
        });
    }

    join(id) {
        var self = this;
        try {
            Channel.findOne({id: this.id}, function(error, data) {
                if(error) throw error;
                if(!data) return;

                var ip = self.socket.handshake.address;
                if(self.socket.handshake.headers["x-real-ip"] && self.config.trustedProxies.indexOf(self.socket.handshake.address) > -1) {
                    //if behind a trusted reverse proxy, use the X-Real-IP header
                    ip = self.socket.handshake.headers["x-real-ip"];
                }

                if((!data.secured || self.socket.request.session.loggedInId === self.id) && data.bannedIPs.indexOf(ip) === -1) {

                    self.socket.join(self.id);
                    console.log(self.socket.client.id + " joined " + id);

                    //assume first user who joins is channel creator
                    var user = {
                        socketId: self.socket.id,
                        username: self.socket.request.session.username,
                        moderator: data.users.length ? false : true
                    };
                    self.io.of("/channel").to(self.id).emit("connected", user);

                    //remove expiration time of channel
                    Channel.findOneAndUpdate({id: self.id}, {$push: {users: user}, $set: {createdAt: null}}, {upsert: true, new: true}, function(error, data) {
                        if(error) throw error;

                        self.socket.emit("setup", data);

                        if(data.users.length == 1) {
                            var channel = data.toIndex();
                            self.io.of("/index").emit("addChannel", channel);
                            return;
                        }
                        self.io.of("/index").emit("incrementUsercount", self.id);
                    });
                }
            });
        }
        catch(error) {
            console.error(error);
        }
    }

    getTime() {
        this.socket.to(this.id).emit("requestTime");
    }

    pushTime(data) {
        this.socket.to(this.id).emit("pushTime", data);
    }

    setEventBool(eventName, callback) {
        var query = {};
        query["users.$." + eventName] = true;

        try {
            Channel.findOneAndUpdate({"users.socketId": this.socket.id}, {$set: query}, {new: true}, function(error, data) {
                if(error) throw error;

                var i;
                var count = 0;
                for(i = 0; i < data.users.length; i++) {
                    if(data.users[i][eventName]) {
                        count++;
                    }
                }

                if(count === data.users.length) {
                    for(i = 0; i < data.users.length; i++) {
                        query["users.$." + eventName] = false;
                        Channel.updateOne({"users.socketId": data.users[i].socketId}, {$set: query}).exec();
                    }
                    callback();
                }

            });
        }
        catch(error) {
            console.error(error);
        }
    }

    ended() {
        var self = this;
        this.setEventBool("ended", function() {
            self.io.of("/channel").to(self.id).emit("nextItem");
        });
    }

    //if all users in a channel have loaded enough data of selected video, start playing it
    ready() {
        var self = this;
        this.setEventBool("ready", function() {
            self.io.of("/channel").to(self.id).emit("play", 0);
            Channel.updateOne({id: self.id}, {playing: true}).exec();
        });
    }

    play(time) {
        var self = this;
        this.isModerator(function() {
            Channel.updateOne({id: self.id}, {playing: true}).exec();
            self.socket.to(self.id).emit("play", time);
        });
    }

    pause(time) {
        var self = this;
        this.isModerator(function() {
            Channel.updateOne({id: self.id}, {playing: false}).exec();
            self.socket.to(self.id).emit("pause", time);
        });
    }

    seeked(time) {
        var self = this;
        this.isModerator(function() {
            self.socket.to(self.id).emit("seeked", time);
        });
    }

    addMedia(data) {
        this.isModerator(() => {
            let ytdl = new YoutubeDL(this.config.youtubedl.bin, this.config.youtubedl.proxy);

            ytdl.on("mediaFound", (item) => {
                try {
                    Channel.findOneAndUpdate({id: this.id}, {$push: {playlist: item}}, {upsert: true, new: true}, (error, data) => {
                        if(error) throw error;
                        item.id = data.playlist[data.playlist.length - 1].id;
                        this.io.of("/channel").to(this.id).emit("addItem", item);
                    });
                }
                catch(error) {
                    console.error(error);
                }
            });

            ytdl.on("getMediaFinished", (extractedMediaCount) => {
                if(extractedMediaCount > 0) {
                    this.socket.emit("getMediaSuccess");
                }
                else {
                    this.socket.emit("getMediaError");
                }
            });

            ytdl.getMedia(data.url, data.addPlaylist);
        });
    }

    removeItem(data) {
        var self = this;
        this.isModerator(function() {
            try {
                Channel.updateOne({id: self.id}, {$pull: {playlist: {_id: data.id}}}, function(error) {
                    if(error) throw error;
                    self.socket.to(self.id).emit("removeItem", data.index);
                });
            }
            catch(error) {
                console.error(error);
            }
        });
    }

    moveItem(data) {
        var self = this;
        this.isModerator(function() {
            try {
                Channel.findOne({id: self.id}, function(error, channelObject) {
                    if(error) throw error;

                    channelObject.playlist.splice(data.newIndex, 0, channelObject.playlist.splice(data.oldIndex, 1)[0]);
                    Channel.updateOne({id: self.id}, {$set: {playlist: channelObject.playlist}}).exec();
                });
                self.socket.to(self.id).emit("moveItem", {oldIndex: data.oldIndex, newIndex: data.newIndex});
            }
            catch(error) {
                console.error(error);
            }
        });
    }

    refreshItem(id) {
        try {
            Channel.findOne({id: this.id}, (error, data) => {
                if(error) throw error;

                //only allow a single client to trigger a refresh
                if(this.socket.id === data.users[0].socketId) {
                    Channel.findOne({"playlist._id": id}, {"playlist.$": 1}, (error, data) => {
                        if(error) throw error;
                        if(!data) return;

                        let ytdl = new YoutubeDL(this.config.youtubedl.bin, this.config.youtubedl.proxy);

                        ytdl.on("mediaFound", (item) => {
                            Channel.findOneAndUpdate({"playlist.id": id}, {$set: {"playlist.$.formats": item.formats}}).exec();
                            this.io.of("/channel").to(this.id).emit("refreshItem", {
                                id: id,
                                error: error,
                                formats: item.formats
                            });
                        });
            
                        ytdl.on("getMediaFinished", (extractedMediaCount) => {
                            if(extractedMediaCount === 0) {
                                this.io.of("/channel").to(this.id).emit("refreshItem", {
                                    id: id,
                                    error: true,
                                    formats: []
                                });
                            }
                        });
            
                        ytdl.getMedia(data.playlist[0].webpage, false);
                    });
                }
            });
        }
        catch(error) {
            console.error(error);
        }
    }

    playItem(index) {
        var self = this;
        this.isModerator(function() {
            self.socket.to(self.id).emit("playItem", index);
        });
    }

    loadPlaylist(items) {
        var self = this;
        this.isModerator(function() {
            try {
                Channel.findOneAndUpdate({id: self.id}, {$set: {playlist: items}}, {upsert: true, new: true}, function(error, data) {
                    if(error) throw error;

                    self.io.of("/channel").to(self.id).emit("loadPlaylist", data.playlist);
                });
            }
            catch(error) {
                console.error(error);
            }
        });
    }

    chatMessage(text) {
        if(text.length > 1000) {
            return;
        }
        var matches = linkify.match(text);
        this.io.of("/channel").to(this.id).emit("chatMessage", {username: this.socket.request.session.username, text: text, urls: matches});
    }

    updateUser(data) {
        data.socketId = this.socket.id;
        this.io.of("/channel").to(this.id).emit("updateUser", data);
    }

    moderatorUpdate(data) {
        var self = this;
        this.isModerator(function() {
            Channel.findOneAndUpdate({"users.socketId": data.socketId}, {$set: {"users.$.moderator": data.moderator}}).exec();
            self.io.of("/channel").to(self.id).emit("moderatorUpdate", data);
        });
    }

    isModerator(callback) {
        var self = this;
        try {
            Channel.findOne({id: this.id}, function(error, data) {
                if(error) throw error;

                for(var i = 0; i < data.users.length; i++) {
                    if(self.socket.id == data.users[i].socketId && data.users[i].moderator) {
                        callback();
                    }
                }
            });
        }
        catch(error) {
            console.error(error);
        }
    }

    kickban(data) {
        var self = this;
        this.isModerator(function() {
            var socket = self.io.nsps["/channel"].sockets[data.socketId];
            if(socket) {
                if(data.ban) {
                    var ip = socket.handshake.address;
                    if(socket.handshake.headers["x-real-ip"] && self.config.trustedProxies.indexOf(socket.handshake.address) > -1) {
                        //if behind a trusted reverse proxy, use the X-Real-IP header
                        ip = socket.handshake.headers["x-real-ip"];
                    }
                    Channel.updateOne({id: self.id}, {$push: {bannedIPs: ip}}).exec();
                }
                data.username = self.getUsername(data.socketId);
                self.io.of("/channel").to(self.id).emit("kickban", data);
                socket.disconnect();
            }
        });
    }

    getUsername(id) {
        var socket = this.io.nsps["/channel"].sockets[id];
        if(socket) return socket.request.session.username;
        return false;
    }

    editChannelName(newName) {
        var self = this;
        this.isModerator(function() {
            if(newName) {
                Channel.updateOne({id: self.id}, {$set: {name: newName}}).exec();
                self.io.of("/channel").to(self.id).emit("updateChannelName", newName);
                self.io.of("/index").emit("updateChannelName", {id: self.id, newName: newName});
            }
        });
    }

    setRepeat(bool) {
        var self = this;
        this.isModerator(function() {
            self.io.of("/channel").to(self.id).emit("setRepeat", bool);
            Channel.updateOne({id: self.id}, {$set: {repeat: bool}}).exec();
        });
    }

    shufflePlaylist(playlist) {
        var self = this;
        this.isModerator(function() {
            self.io.of("/channel").to(self.id).emit("shufflePlaylist", playlist);
            Channel.updateOne({id: self.id}, {$set: {playlist: playlist}}).exec();
        });
    }

    disconnect() {
        this.socket.to(this.id).emit("disconnected", {socketId: this.socket.id, username: this.socket.request.session.username});

        var self = this;
        try {
            Channel.updateOne({id: this.id}, {$pull: {users: {socketId: this.socket.id}}}, function(error, data) {
                if(error) throw error;
                if(!data) return;
        
                self.io.of("/index").emit("decrementUsercount", self.id);

                Channel.findOne({id: self.id}, function(error, data) {
                    if(error) throw error;
                    if(!data) return;

                    if(data.users.length == 0) {
                        Channel.deleteOne({id: self.id}, function(error) {
                            if(error) throw error;
              
                            self.io.of("/index").emit("removeChannel", self.id);
                        });
                    }
                    else {
                        var noModerator = true;
                        for(var i = 0; i < data.users.length; i++) {
                            if(data.users[i].moderator) noModerator = false;
                        }
                        if(noModerator) {
                            data = {socketId: data.users[0].socketId, moderator: true};
                            Channel.findOneAndUpdate({"users.socketId": data.socketId}, {$set: {"users.$.moderator": data.moderator}}).exec();
                            self.io.of("/channel").to(self.id).emit("moderatorUpdate", data);
                        }
                    }
                });
            });
        }
        catch(error) {
            console.error(error);
        }

        console.log(this.socket.client.id + " left " + this.id);
    }
}

module.exports = ChannelSocketController;
