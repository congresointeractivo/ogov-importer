/** Storer that stores data in a billit instance.
 *
 * @param {String} dataDir Directory to store data. Cannot be null.
 * @param {Number} [options.deph] Number of directory levels to balance the
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
      }
      queue.empty();
  }());


  /** toPopolo
   * @type Function
   * @param ogovBill ogovBill
   * Recieves an bill formatted by billImporter and exports a popolo object
   */
  function toPopolo(ogovBill) {

    var billitAuthors = [];
    for (s in ogovBill.subscribers) {
      billitAuthors.push(ogovBill.subscribers[s].name);
    }

    var yearOfLastAction;

    var billitPaperworks = [];
    for (d in ogovBill.dictums) {
      var dictum = ogovBill.dictums[d];

      var billitPaperwork =  {}
      if (!dictum["date"]) {
        LOG.error("Error: Dictum without date",ogovBill.file,dictum)
      }
      else {
        billitPaperwork.session = dictum["orderPaper"]
        billitPaperwork.date = dictum["date"]
        billitPaperwork.description = dictum["result"]
        billitPaperwork.stage = ""
        billitPaperwork.chamber = dictum["source"]

        billitPaperwork.bill_id = ogovBill.file
        billitPaperwork.bill_uid = ogovBill.file
        billitPaperwork.timeline_status = "Indicaciones"


        billitPaperworks.push(billitPaperwork);

        yearOfLastAction = (new Date(dictum["date"]).getYear() > yearOfLastAction) ? new Date(dictum["date"]).getTime() : yearOfLastAction;

      }
    }
    //console.log(billitPaperworks);

    //DICTAMENES DE COMISION
    // file: rawBill.file,
    // source: importer.errorIfEmpty(procedureData.eq(0)),
    // topic: importer.defaultIfEmpty(procedureData.eq(1)),
    // date: importer.convertDate(importer.defaultIfEmpty(procedureData.eq(2))),
    // result: importer.defaultIfEmpty(procedureData.eq(3))    
    var billitDirectives = [];
    for (p in ogovBill.procedures) {
      var procedure = ogovBill.procedures[p];

      if (!procedure["topic"]) {
        LOG.error("Error: procedure without topic",procedure,ogovBill.file)
      } else {
        var billitDirective = {};
        billitDirective.date = procedure["date"];
        billitDirective.step = procedure["topic"];
        billitDirective.stage = procedure["result"];
        billitDirective.link = "";
        billitDirective.bill_uid = ogovBill.file
        billitDirective.bill_id = ogovBill.file
        billitDirective.source = procedure["source"]

        billitDirectives.push(billitDirective);

        yearOfLastAction = (new Date(procedure["date"]).getYear() > yearOfLastAction) ? new Date(procedure["date"]).getTime() : yearOfLastAction;
        
      }

      //console.log(billitDirectives);


    } 

    if (!ogovBill.summary) {
      LOG.error("NO SUMMARRY",ogovBill);
    }

    var billitBill = {
      "uid": ogovBill.file,
      "title": ogovBill.summary ? ogovBill.summary.replace("%","\%") : "ERROR - LEY SIN SUMARIO",
      "creation_date": ogovBill.creationTime,
      "source": ogovBill.source,
      "initial_chamber": ogovBill.source, //This we have to find out more, becase it cannot be "PE"
      "bill_draft_link": ogovBill.textUrl,
      "subject_areas": ogovBill.committees,
      "authors": billitAuthors,
      "paperworks": billitPaperworks,
      "directives": billitDirectives,
      "lawNumber": ogovBill.lawNumber,
      "stage": "Ingresado",
      "project_type": ogovBill.type.replace("PROYECTO DE ",""),

      "current_priority": "Normal",

      //We don't have any of these
      "priorities":[],
      "reports":[],
      "documents":[],
      "remarks":[],
      "revisions":[],
    }

    yearOfLastAction = (ogovBill.file.split("-")[2] > yearOfLastAction) ? ogovBill.file.split("-")[2] : yearOfLastAction;








    // Si existe, se considera "Ingresado"

    //Si tiene un dictámen, considero que el estado es "Con dictámen en Cámara de Orígen"
    for (b in billitBill.paperworks) {
      description = billitBill.paperworks[b].description;
      if(description.indexOf("SOLICITUD DE SER COFIRMANTE") == -1) {
        //console.log(description);
        billitBill.stage = "Con dictámen en Cámara de Orígen";
      }
    }

    //Si tiene un trámite cuyo estado es APROBADO, entonces lo considero "Con media sanción" 
    //si es una ley, o Aprobado si es un proyecto de declaración, resolución o mensaje.
    if (billitBill.directives.length > 0) {
      if (billitBill.directives[0].stage == "APROBADO") {
        if (billitBill.project_type == "LEY") {
          billitBill.stage = "Con media sanción";
        }
        else {
          billitBill.stage = "Aprobado o sancionado";        
        }
      }
      // Si en el primer trámite, el estado NO ES APROBADO, entonces lo considero "Rechazado"
      else {
        //  console.log(billitBill.project_type,ogovBill.procedures);
        billitBill.stage = "Rechazado";
      }
      //Si tiene más de un trámite y el resultado del segundo trámite es SANCIONADO, lo considero Sancionado.
      if (billitBill.directives.length > 1) {
        if (billitBill.directives[1].result == "SANCIONADO") {
          billitBill.stage = "Aprobado o sancionado";
        }
        //Si el resultado del segundo trámite NO ES SANCIONADO lo considero "Rechazado".
        else {
          billitBill.stage = "Rechazado";
        }
      }
    }

    // Si tiene número de ley es porque está aprobada
    if (billitBill.lawNumber) {
          billitBill.stage = "Aprobado o sancionado";    
    }

    //Si no está aprobado ni rechazado y la última acción fué hace más de dos años, entonces no tiene estado parlamentario
    if (billitBill.stage !== "Rechazado" && billitBill.stage !== "Aprobado o sancionado" && 
      yearOfLastAction <= new Date().getYear() - 2) {
      billitBill.stage = "Perdida de estado parlamentario";
    }

    return billitBill;

  }

  /** pushToBillit
   * @type Function
   * @param instance url
   * @param data popolo formatted bill
   * @param callback function for marking the queue process end
   */
  function pushToBillit(instance,data,callback) {
    //require('request').debug = true;
    url = instance+"/bills"
    // data = {"bill": JSON.stringify(data)}
    //console.log(data);
    // r = request.post(url, function (err, response, body) {
    //   console.log(err,response);
    // });

   request(
      { method: 'GET'
      , uri: url + "/" + data.uid + ".json"
      }
    , function (error, response, body) {
      var method;
        if(!response){
          LOG.error("Connection error", url, data.uid);
          delete data;
          callback();
          return;
        }
        else if(response.statusCode == 500){
          LOG.error("Server error", data.uid);
          delete data;
          callback();
          return;
        }
        else if(response.statusCode == 200){
          method = "PUT"
          uri = url + "/" + data.uid
        } else {
          method = "POST"
          uri = url;
        }
        //console.log("BILL",data.uid,method,response.statusCode);
  
        request(
          { method: method
          , uri: uri
          , 'content-type': 'application/json'
          ,  body: JSON.stringify(data)
          }
        , function (error, response, body) {
            if(response && response.statusCode == 302){
              LOG.info('document saved',data.uid,method,response.statusCode);
            } else {
              LOG.error('error: ' + url + ' ' + response.statusCode || response, data.uid)
              LOG.error(body)
            }
            delete data;
            callback();
            return;
          }
        )

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
  }
};
