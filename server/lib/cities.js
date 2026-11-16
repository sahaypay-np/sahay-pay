// Sahay Pay — static Nepal/India city coordinates (phase 2, items 41–46, 106).
// Bundled data, no geolocation API and no external service: the app's
// Permissions-Policy disables geolocation, so "near me" is computed from
// the user's home city against this table. Served to the client via
// /config so server and client can never drift apart.
// Coordinates: approximate city centres, good enough for a radius filter.

'use strict';

// [name, country, lat, lon]
const CITIES = [
  // Nepal
  ['Kathmandu', 'NP', 27.7172, 85.3240],
  ['Pokhara', 'NP', 28.2096, 83.9856],
  ['Bhairahawa', 'NP', 27.5078, 83.4502],
  ['Siddharthanagar', 'NP', 27.5078, 83.4502],
  ['Butwal', 'NP', 27.7000, 83.4500],
  ['Biratnagar', 'NP', 26.4525, 87.2718],
  ['Birgunj', 'NP', 27.0100, 84.8800],
  ['Dharan', 'NP', 26.8147, 87.2796],
  ['Bharatpur', 'NP', 27.6833, 84.4167],
  ['Nepalgunj', 'NP', 28.0500, 81.6167],
  ['Dhangadhi', 'NP', 28.7000, 80.6000],
  ['Janakpur', 'NP', 26.7288, 85.9254],
  ['Hetauda', 'NP', 27.4289, 85.0324],
  ['Itahari', 'NP', 26.6667, 87.2667],
  ['Lalitpur', 'NP', 27.6670, 85.3167],
  ['Bhaktapur', 'NP', 27.6720, 85.4298],
  ['Lumbini', 'NP', 27.5700, 83.2700],
  ['Surkhet', 'NP', 28.6000, 81.6167],
  ['Dang', 'NP', 28.0000, 82.3000],
  ['Ilam', 'NP', 26.9000, 87.9167],
  ['Tansen', 'NP', 27.8670, 83.5500],
  ['Gorkha', 'NP', 28.0000, 84.6333],
  ['Baglung', 'NP', 28.2667, 83.6000],
  ['Mahendranagar', 'NP', 28.9667, 80.1833],
  ['Tikapur', 'NP', 28.5333, 81.1167],
  // India
  ['Delhi', 'IN', 28.6139, 77.2090],
  ['Mumbai', 'IN', 19.0760, 72.8777],
  ['Kolkata', 'IN', 22.5726, 88.3639],
  ['Chennai', 'IN', 13.0827, 80.2707],
  ['Bengaluru', 'IN', 12.9716, 77.5946],
  ['Hyderabad', 'IN', 17.3850, 78.4867],
  ['Pune', 'IN', 18.5204, 73.8567],
  ['Ahmedabad', 'IN', 23.0225, 72.5714],
  ['Jaipur', 'IN', 26.9124, 75.7873],
  ['Lucknow', 'IN', 26.8467, 80.9462],
  ['Patna', 'IN', 25.5941, 85.1376],
  ['Varanasi', 'IN', 25.3176, 82.9739],
  ['Gorakhpur', 'IN', 26.7606, 83.3732],
  ['Agra', 'IN', 27.1767, 78.0081],
  ['Kanpur', 'IN', 26.4499, 80.3319],
  ['Surat', 'IN', 21.1702, 72.8311],
  ['Indore', 'IN', 22.7196, 75.8577],
  ['Bhopal', 'IN', 23.2599, 77.4126],
  ['Nagpur', 'IN', 21.1458, 79.0882],
  ['Guwahati', 'IN', 26.1445, 91.7362],
  ['Dehradun', 'IN', 30.3165, 78.0322],
  ['Chandigarh', 'IN', 30.7333, 76.7794],
  ['Amritsar', 'IN', 31.6340, 74.8723],
  ['Ludhiana', 'IN', 30.9010, 75.8573],
  ['Kochi', 'IN', 9.9312, 76.2673],
  ['Thiruvananthapuram', 'IN', 8.5241, 76.9366],
  ['Bhubaneswar', 'IN', 20.2961, 85.8245],
  ['Ranchi', 'IN', 23.3441, 85.3096],
  ['Raipur', 'IN', 21.2514, 81.6296],
  ['Jodhpur', 'IN', 26.2389, 73.0243],
  ['Udaipur', 'IN', 24.5854, 73.7125],
  ['Shimla', 'IN', 31.1048, 77.1734],
  ['Srinagar', 'IN', 34.0837, 74.7973],
  ['Siliguri', 'IN', 26.7271, 88.3953],
  ['Darjeeling', 'IN', 27.0410, 88.2663],
  ['Gangtok', 'IN', 27.3389, 88.6065],
  ['Panaji', 'IN', 15.4909, 73.8278],
  ['Mysuru', 'IN', 12.2958, 76.6394],
  ['Coimbatore', 'IN', 11.0168, 76.9558],
  ['Madurai', 'IN', 9.9252, 78.1198],
  ['Vijayawada', 'IN', 16.5062, 80.6480],
  ['Visakhapatnam', 'IN', 17.6868, 83.2185],
  ['Nashik', 'IN', 19.9975, 73.7898],
  ['Rajkot', 'IN', 22.3039, 70.8022],
  ['Vadodara', 'IN', 22.3072, 73.1812],
  ['Jabalpur', 'IN', 23.1815, 79.9864],
  ['Gwalior', 'IN', 26.2183, 78.1828],
  ['Meerut', 'IN', 28.9845, 77.7064],
  ['Prayagraj', 'IN', 25.4358, 81.8463],
  ['Bareilly', 'IN', 28.3670, 79.4304],
  ['Jalandhar', 'IN', 31.3260, 75.5762],
  ['Kota', 'IN', 25.2138, 75.8648],
  ['Ajmer', 'IN', 26.4499, 74.6399],
  ['Ujjain', 'IN', 23.1765, 75.7885],
  ['Mangaluru', 'IN', 12.9141, 74.8560],
  ['Warangal', 'IN', 18.0001, 79.5581],
  ['Guntur', 'IN', 16.3067, 80.4365],
  ['Tirupati', 'IN', 13.6288, 79.4192],
];

function findCity(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const row = CITIES.find((c) => c[0].toLowerCase() === n);
  return row ? { name: row[0], country: row[1], lat: row[2], lon: row[3] } : null;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { CITIES, findCity, haversineKm };
