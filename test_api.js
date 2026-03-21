const url = "http://localhost:8080/api/discovery?username=Arnuv_J";
fetch(url)
  .then(async res => {
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Body:", text.substring(0, 300));
  })
  .catch(err => {
    console.error("Fetch Error:", err);
  });
