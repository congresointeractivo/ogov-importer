/** Storer that stores data in a billit instance.
 *
 * @param {String} instance The URL of the billit server to store the data
 * @param {Number} [options.depth] Number of directory levels to balance the
 *    tree. Default is 0, which means the root data dir will store all items.
 * @constructor
 */
module.exports = function PopoloStorer(instance, options) {

  /** Simple HTTP client for node.
   * @type {Function}
   * @private
   * @fieldOf Importer#
   */
  var request = require("request");

  /** Async flow contro library.
   * @type Object
   * @private
   * @fieldOf Importer#
   */
  var async = require("async");

  /** Class logger, using the default if no one is provided.
   * @type winston.Logger
   * @constant
   * @private
   */
  var LOG = options && options.logger || require("winston");

  /** Number of concurrently tasks scrapping pages at the same time.
   * @type Number
   * @constant
   * @private
   * @fieldOf Importer#
   */
  var POOL_SIZE = options && options.poolSize || 2;


  /** Class queue of bills to store
   * @type async.queue
   * @constant
   * @private
   */
  var queue = {};

  /** Enumerator of possible bill stages
   * @type Object
   * @constant
   * @private
   */
  var STAGE = {
    SUBMITTED: "Ingresado",
    CONSIDERING: "En consideración",
    DICTUM_ORIGIN: "Con dictámen en Cámara de Orígen",
    HALF_SANCTION: "Con media sanción",
    DICTUM_REVISORY: "Con dictámen en Cámara Revisora",
    APPROVED: "Aprobado o sancionado",
    REJECTED: "Rechazado",
    PARLIAMENTARY_STATUS_LOST: "Perdida de estado parlamentario"
  };


  /** Constructor 
  */
  (function __constructor() {
      queue = async.queue(function (task, callback) {
        // Let GC do its job.
        process.nextTick(function () {
          pushToBillit(instance,task,callback);
        });
      }, POOL_SIZE);

      queue.empty = function () {
        LOG.info("Queue empty. Adding another " + POOL_SIZE +
          " pages to the queue.");
      };
      queue.empty();
  }());


  /** toPopolo
   * @type Function
   * @param ogovBill ogovBill
   * Recieves an bill formatted by billImporter and exports a popolo object
   */
  function toPopolo(ogovBill) {

    var billitAuthors = ogovBill.subscribers.map(function (subscriber) {
      return subscriber.name;
    });    

    //This corresponds to the "DICTAMENES DE COMISION" section in the HCDN page.
    var billitPaperworks = ogovBill.dictums.map(function(dictum) {
      if (!dictum["date"]) {
        if (!(dictum["result"] && dictum["result"].indexOf("ARTICULO") > -1)) {
          LOG.info("Dictum without date",ogovBill.file,dictum);
        }
        dictum["date"] = ogovBill.date;
      }

      return {
        session: dictum["orderPaper"],
        date: dictum["date"],
        step: dictum["result"],
        stage: "",
        chamber: dictum["source"],
        bill_id: ogovBill.file,
        bill_uid: ogovBill.file,
        timeline_status: "Indicaciones", //TODO: Use the proper status
      };
    });

    //This corresponds to the "TRAMITE" section in the HCDN page
    var billitDirectives = ogovBill.procedures.map(function(procedure) {
      if (!procedure["date"]) {
        if(procedure["topic"].indexOf("COMUNICADO EL")) {
          procedure["date"] = procedure["topic"].substr(procedure["topic"].indexOf("COMUNICADO EL")+14,10);
        }
        else {
          LOG.info("Procedure without date",ogovBill.file,procedure);
          procedure["date"] = ogovBill.date;
        }
      }

      if (!procedure["topic"]) {
        //Estoy asumiendo que si es de senado y no tiene topic, fué una votación!
        if (procedure["source"] === "Senado") {
          procedure["topic"] = "Votación";
        }
        else {
          LOG.error("Error: procedure without topic",procedure,ogovBill.file);
        }
      }

      return {
        date: procedure["date"],
        step: procedure["topic"],
        stage: procedure["result"],
        link: "",
        bill_uid: ogovBill.file,
        bill_id: ogovBill.file,
        source: procedure["source"]
      };
    });

    if (!ogovBill.summary) {
      LOG.debug("NO SUMMARRY",ogovBill);
    }

    var billitBill = {
      "uid": ogovBill.file,
      "title": ogovBill.summary ? ogovBill.summary.replace("%","\\%") : "ERROR - LEY SIN SUMARIO",
      "creation_date": ogovBill.creationTime,
      "source": ogovBill.source,
      "initial_chamber": ogovBill.source, //This we have to find out more, becase it cannot be "PE"
      "bill_draft_link": ogovBill.textUrl,
      "subject_areas": ogovBill.committees,
      "authors": billitAuthors,
      "paperworks": billitPaperworks,
      "directives": billitDirectives,
      "lawNumber": ogovBill.lawNumber,
      "stage": STAGE.SUBMITTED,
      "project_type": ogovBill.type.replace("PROYECTO DE ",""),
      "current_priority": "Normal",
      //We don't have any of these
      "priorities":[],
      "reports":[],
      "documents":[],
      "remarks":[],
      "revisions":[],
    };


    //Calculating Project status


    //If it has a dictum, we consider it DICTUM_ORIGIN
    billitBill.paperworks.forEach(function (billitPaperwork) {
      if(billitPaperwork.chamber === -1) {
        if (billitPaperwork.chamber === billitBill.source) {
          billitBill.stage = STAGE.DICTUM_ORIGIN;
        }
        else {
          billitBill.stage = STAGE.DICTUM_REVISORY;
        }
      }
    });

    //Projects have two years of parliamnetary status
    //Unless they have half-sanction, in that case they last three
    var project_duration = 2;
    var creation_date = new Date(Date.parse(billitBill.creation_date));
    var creation_year = creation_date.getYear();


    //If it has a directive (tramite) with APPROVED status, then we consider it "Con media sanción" 
    //if it's a law, or Aprobado if it's a declaration, resolution or message.
    billitBill.directives.forEach(function(billitDirective) {
      if (billitDirective.chamber === billitBill.source) {

        if (billitDirective.step.indexOf("CONSIDERACION") > -1 ||
          billitDirective.step.indexOf("ARTICULO 114") > -1 ||
          billitDirective.step.indexOf("ARTICULO 204") > -1) {
          if (billitDirective.stage === "MEDIA SANCION") {
            billitBill.stage = STAGE.HALF_SANCTION;
            var directive_year = new Date(Date.parse(billitDirective.date)).getYear();
            if (directive_year > creation_year) {
              project_duration = 3;
            }

          }
          else if (billitDirective.stage === "SANCIONADO" || billitDirective.stage === "APROBADO") {
            billitBill.stage =  STAGE.APPROVED;
          }
          else if (billitDirective.stage === "RECHAZADO") {
            billitBill.stage = STAGE.REJECTED;
          }
          else if (billitDirective.stage === "") {
            billitBill.stage =  STAGE.CONSIDERING;
          }
          else {
            LOG.info("popoloStorer directive with undetected stage",billitDirective);
          }
        }
        else if(billitDirective.step.indexOf("SOLICITUD DE SER COFIRMANTE") > -1) {
          //Ignore co-sponsoring requests
          billitDirective = null;
        }
        else if(billitDirective.step.indexOf("TABLAS") > -1) {
          //Ignore "mocion de tratar sobre tablas"
        }
        else if(billitDirective.step.indexOf("SESION ESPECIAL") > -1) {
          //Ignore "llamado a sesion especial"
        }
        else {
          LOG.info("popoloStorer directive with undetected step",billitDirective);
        }
      }

      //Revisory chamber
      else {
        if (billitDirective.step.indexOf("CONSIDERACION") > -1) {
          if (billitDirective.stage === "MEDIA SANCION") {
            billitBill.stage = STAGE.HALF_SANCTION;
          }
          else if (billitDirective.stage === "SANCIONADO" || billitDirective.stage === "APROBADO") {
            billitBill.stage = STAGE.APPROVED;
          }
          else if (billitDirective.stage === "RECHAZADO") {
            billitBill.stage = STAGE.REJECTED;
          }
          //Some resolution projects are considered and archived, that means approved
          else if (billitDirective.stage === "ARCHIVADO") {
            billitBill.stage = STAGE.APPROVED;
          }
          else if (billitDirective.stage === null) {
            billitBill.stage = STAGE.CONSIDERING;
          }
          else {
            LOG.info("popoloStorer directive with undetected stage in revisory chamber",billitDirective);
          }
        }
        else if(billitDirective.step.indexOf("SOLICITUD DE SER COFIRMANTE") === -1) {
          //Ignore "solicitud de ser cofirmante"
          billitDirective = null;
        }

        else if(billitDirective.step.indexOf("TABLAS") === -1) {
          //Ignore "mocion de tratar sobre tablas"
        }
        else if(billitDirective.step.indexOf("SESION ESPECIAL") === -1) {
          //Ignore "llamado a sesion especial"
        }
        else {
          LOG.info("popoloStorer directive with undetected step",billitDirective);
        }
      }

    });

    //If it has law number, it was approved
    if (billitBill.lawNumber) {
          billitBill.stage = STAGE.APPROVED;
    }

    //2011-09-10 -- cae 28/02/2013
    //2012-02-10 -- cae 28/02/2013
    //2013-05-10 -- cae 28/02/2015
    //2013-02-10 -- cae 28/02/2014
    //2011
    //2012
    //2013
    //2013

    //If project creation is january or febrary
    //It belongs to the previous parliamentary period
    if (creation_date.getMonth() < 3) {
      creation_year--;
    }
    //2011 2013
    //2013 2015
    //2012 2014

    //If the project was created more than two years ago,
    //It has lost the parliamentary status
    if(creation_year + project_duration < new Date().getYear()) {
      billitBill.stage = STAGE.PARLIAMENTARY_STATUS_LOST;      
    }
    //If the project was created exactly two years ago,
    //And we're after febrary, It has lost the parliamentary status
    if(creation_year + project_duration === new Date().getYear() && new Date().getMonth() >= 3) {
      billitBill.stage = STAGE.PARLIAMENTARY_STATUS_LOST;      
    }

    return billitBill;

  }

  /** pushToBillit
   * @type Function
   * @param {String} billitUrl The base URL of the billit API endpoints.
   * @param {Object} billitBill JSON Structure for a bill, formatted using the Popolo Standard
   * @param {function} callback Function for marking the queue process end
   */
  function pushToBillit(billitUrl,billitBill,callback) {
    //require('request').debug = true;
    var url = billitUrl+"/bills";

   request(
      { 
        method: 'GET', 
        uri: url + "/" + billitBill.uid + ".json?fields=uid"
      }, 
      function (error, response, body) {
        var method,uri;
        if(!response){
          LOG.error("Connection error", url, billitBill.uid);
          billitBill = null;
          callback();
          return;
        }
        else if(response.statusCode === 500){
          LOG.error("Server error", billitBill.uid);
          billitBill = null;
          callback();
          return;
        }
        else if(response.statusCode === 200){
          method = "PUT";
          uri = url + "/" + billitBill.uid;
        } else {
          method = "POST";
          uri = url;
        }
        //console.log("BILL",billitBill.uid,method,response.statusCode);
  
        request(
          { 
            method: method, 
            uri: uri, 
            'content-type': 'application/json',  
            body: JSON.stringify(billitBill)
          }, 
          function (error, response, body) {
            if(response && response.statusCode === 302){
              LOG.info('document saved',billitBill.uid,method,response.statusCode);
            } else {
              LOG.error('error: ' + url + ' ' + response.statusCode || response, billitBill.uid);
              LOG.error(body);
            }
            billitBill = null;
            callback();
            return;
          }
        );

      }
    );



  }

  return {

    /** Stores the specified data object into billit.
     *
     * @param {String} id Unique id to identify this data. It is used as file
     *    name. Cannot be null or empty.
     * @param {Object} data Object having the data to store. Cannot be null.
     * @param {String} role Role of the specified data. Can be null.
     * @param {Function} callback Callback invoked when the data is already
     *    saved. Cannot be null.
     */
    store: function (id, data, role, callback) {
      queue.push(toPopolo(data));
      callback();
    },
  };
};
