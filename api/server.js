const express = require('express');
const db = require('monk')(process.env.MONGO_URI);
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = process.env.PORT || 3001;
const hpfeed = db.get('sessiondata');
const interactionEngineURI = process.env.INTERACTION_URI;
const maxInteractionCount = 20;
let currentInteractionData = [];
let currentAggregates = {};

const getAggregates = data => {
    let total_attacks = data.length;
    let url_collections = data.map(event => event.url).filter(urls => urls.length); /* Forming array of arrays from attacks where URLs were seen */
    let total_urls = [].concat.apply([], url_collections).length /* Calculating total number of elements. Does not check if URL is unique or has been seen before */
    let hash_collections = data.map(event => event.shasum).filter(hashes => hashes.length);
    let total_hashes = [].concat.apply([], hash_collections).filter(string => {return string !== '';}).length;
    return {
        attacks: total_attacks,
        urls: total_urls,
        hashes: total_hashes
    };
}

const getAllInteractions = async () => {
    return await hpfeed.find({}, (err) => {
        if (err) return "Error accessing database";
    });
}

const getAllInteractionsFromLast24Hours = async() => {
    const earliestTimestamp = new Date().getTime() - (24 * 60 * 60 * 1000);
    return await hpfeed.find({ startTime: { $gt: new Date(earliestTimestamp).toISOString() }}, err => {
        if (err) return "Error accessing database";
    });
}

const getLastNInteractions = async interactionsCount => {
    return await hpfeed.find({ commands: { $exists: true, $ne: [] } }, { sort: { _id: -1  }, limit: interactionsCount }, err => { // Filter returns only sessions where commands field is non-empty
        if (err) return "Error accessing database";
    });
}

const getDBAndEmit = async sockets => {
    let lastNInteractionData = await getLastNInteractions(maxInteractionCount);
    let allInteractionData = await getAllInteractionsFromLast24Hours();
    if (!( JSON.stringify(lastNInteractionData) === JSON.stringify(currentInteractionData) )) {
        currentInteractionData = lastNInteractionData;
        const interactionDataWithDetections = await generateInteractionDataWithDetections(lastNInteractionData);
        sockets.emit("hpfeed", interactionDataWithDetections);
    };

    let lastAggregates = getAggregates(allInteractionData);

    if (!( JSON.stringify(lastAggregates) === JSON.stringify(currentAggregates) )) { // Update aggregrates for all attacks including those with no commands
        currentAggregates = lastAggregates;
        sockets.emit("aggregates", currentAggregates);
    }
}

// use this function to enrich interaction data with detections.
const generateInteractionDataWithDetections = async interactionData => {
    const interactionDataToSend = [];
    await Promise.all(interactionData.map(async item => {
        let itemCopy = Object.assign({}, item);
        const detections = await getInteractionAnalysis(itemCopy);
        itemCopy.detections = detections;
        interactionDataToSend.push(itemCopy);
    }));
    if (interactionDataToSend.length === interactionData.length) {
        return interactionDataToSend;
    }
}

const checkInteractionEngineIsOnline = async () => {
    axios.get(`${interactionEngineURI}/`)
    .then(res => {
        if (res.data.message === 'success') return true;
        else return false;
    })
    .catch(err => {
        console.error(err);
    })
}

const getInteractionAnalysis = async interactionData => {
    interactionData._id = interactionData._id.toString();
    interactionData.startTime = interactionData.startTime.toString();

    if (!interactionData.detections) { 

        if (!interactionData.endTime) {
            return []; // Only provides analysis once session is completed to ensure all commands analysed
        }

        let creds = interactionData.credentials.username + ':' + interactionData.credentials.password;

        let res = await axios.post(`${interactionEngineURI}/analyze`, {
            honeypot_data: interactionData,
            credentials: creds // Support simple YARA rules on credentials in form user:pass
        })

        hpfeed.update(
            { "_id" : interactionData._id}, 
            { $set: {"detections" : res.data.detections } },
            { upsert: false }
        );

        return res.data.detections;
    }

    else {
        return interactionData.detections;
    }
    
}

// Finds entries for files uploaded without commands (ie SFTP) and submits for analysis
const analyseUploadFiles = async() => {
    let uploadFiles = await hpfeed.find({ fileAnalysed: false, "endTime": {"$exists": true, "$ne": ""}}, err => { 
        if (err) return "Error accessing database";
    });

    await Promise.all(uploadFiles.map(async item => {
        let itemCopy = Object.assign({}, item);
        let res = await axios.post(`${interactionEngineURI}/analyze`, {
            honeypot_data: itemCopy
        });

        hpfeed.update(
            { "_id" : itemCopy._id}, 
            { $set: {"fileAnalysed" : true } },
            { upsert: false }
        )
    }));
}


let interval;
io.on('connection', socket => {
    console.log('New Client Connected:' + socket.id);

    getLastNInteractions(maxInteractionCount).then(interactionData => {
        generateInteractionDataWithDetections(interactionData).then(data => {
            socket.emit("hpfeed", data);
        });
    });
    
    getAllInteractionsFromLast24Hours().then(allInteractionData => {
        socket.emit("aggregates", getAggregates(allInteractionData));
    });

    analyseUploadFiles();

    if (interval) clearInterval(interval);
    interval = setInterval(() =>
        getDBAndEmit(io.sockets), 1000
    );

    socket.on("disconnect", () => {
        console.log('Client Disconnected')
    });
});

io.listen(port, () => {
    console.log(`Running API on Port ${port}`)
})
