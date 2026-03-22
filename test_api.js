const http = require('http');
http.get('http://localhost:8080/api/discovery?username=Arnuv_J&period=overall', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log("Artists Count:", json.artists ? json.artists.length : "None");
            console.log("Active Seeds:", json.active_seed_count);
            if (json.artists && json.artists.length > 0) {
               console.log("First Artist Name:", json.artists[0].name);
               console.log("Composite Score:", json.artists[0].composite_score);
            }
        } catch (e) {
            console.error("JSON Parse Error:", e.message, "\nRaw Data:", data.substring(0, 100));
        }
    });
}).on("error", (err) => {
    console.log("Error: " + err.message);
});
