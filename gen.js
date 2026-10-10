const fs = require('fs');

const fNames = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Kabir", "Anaya", "Diya", "Myra", "Kiara", "Saanvi", "Aadhya", "Pari", "Navya", "Anika", "Prateek", "Rahul", "Neha", "Rohan", "Pooja", "Vikram", "Sneha", "Karan", "Priya", "Amit", "Riya", "Raj", "Sonal", "Nikhil", "Simran", "Varun", "Tanvi", "Siddharth", "Kriti", "Akash", "Meera", "Rishabh", "Shruti", "Aditi", "Bhavya", "Chirag", "Deepak", "Esha", "Gaurav", "Harsh", "Ira"];
const lNames = ["Sharma", "Patel", "Singh", "Gupta", "Mehta", "Verma", "Nair", "Iyer", "Joshi", "Malhotra", "Reddy", "Kapoor", "Desai", "Khan", "Ghosh", "Menon", "Choudhary", "Banerjee", "Saxena", "Bhatia", "Chopra", "Dutta", "Garg", "Jain", "Kaur", "Mishra", "Pandey", "Rajput", "Rao", "Shah", "Thakur", "Tiwari", "Yadav", "Acharya", "Bose", "Chatterjee", "Das", "Dube", "Gowda", "Hegde", "Jha", "Kulkarni", "Mohanty", "Mukherjee", "Nayak", "Pillai", "Prasad", "Rajan", "Sengupta"];
const diseases = ["viral fever", "asthma attack", "fracture arm", "food poisoning", "chest pain", "migraine", "dengue", "kidney infection", "typhoid", "pneumonia", "high fever", "appendicitis", "dehydration", "allergic reaction", "covid symptoms", "throat infection", "malaria", "back pain", "gall bladder pain", "mild concussion", "stomach ache", "burn wound", "sprained ankle", "severe headache", "palpitations", "kidney stones", "jaundice", "diarrhea", "blood pressure drop", "cardiac arrest"];
const roomsList = ["General", "ICU", "Normal", "Deluxe", "General", "Normal"]; // Weighted
const emergencies = [1, 2, 3, 4, 5, 2, 3, 2, 1, 4]; // Weighted

const res = [];
for (let i = 1; i <= 500; i++) {
  const name = `${fNames[Math.floor(Math.random() * fNames.length)]} ${lNames[Math.floor(Math.random() * lNames.length)]}`.toLowerCase();
  const disease = diseases[Math.floor(Math.random() * diseases.length)];
  const preferredRoom = roomsList[Math.floor(Math.random() * roomsList.length)];
  const emergencyLevel = emergencies[Math.floor(Math.random() * emergencies.length)];
  res.push({
    id: i,
    name,
    disease,
    preferredRoom,
    emergencyLevel
  });
}

fs.writeFileSync('src/data/patients-500.json', JSON.stringify(res, null, 2), 'utf-8');
console.log('done');
