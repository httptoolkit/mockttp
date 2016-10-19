import sinonChai = require("sinon-chai");
import chaiAsPromised = require("chai-as-promised");
import chai = require("chai");

chai.use(sinonChai);
chai.use(chaiAsPromised);

export default chai.expect;
