let online = false;

module.exports = {
  setOnline(b) {
    online = Boolean(b);
  },
  isOnline() {
    return online;
  },
};
